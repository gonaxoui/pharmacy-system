require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Driver } = require('ydb-sdk');
const grpc = require('@grpc/grpc-js');
const net = require('net');
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const bcrypt = require('bcrypt');

// Конфигурация
const config = {
    port: process.env.SERVER_PORT || 3001,
    ydb: {
        endpoint: process.env.YDB_ENDPOINT,
        database: process.env.YDB_DATABASE,
        token: process.env.YDB_ACCESS_TOKEN,
        sslRootCert: process.env.YDB_SSL_ROOT_CERT || path.join(__dirname, 'ydb_ca.pem')
    }
};

// Проверка сетевой доступности
async function checkNetwork(host, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', () => {
            resolve(false);
        });
        socket.connect(port, host);
    });
}

// Валидация конфигурации
function validateConfig() {
    console.log('[1/4] Проверка конфигурации...');
    const required = ['YDB_ENDPOINT', 'YDB_DATABASE', 'YDB_ACCESS_TOKEN'];
    const missing = required.filter(key => !process.env[key]);
    if (missing.length) {
        throw new Error(`Отсутствуют переменные: ${missing.join(', ')}`);
    }
    if (!fs.existsSync(config.ydb.sslRootCert)) {
        throw new Error(`SSL сертификат не найден: ${config.ydb.sslRootCert}`);
    }
    console.log('✅ Конфигурация проверена');
}

// Инициализация драйвера YDB
async function initYDBDriver() {
    try {
        const [host, port = '2135'] = config.ydb.endpoint.split(':');
        console.log(`[2/4] Проверка сети ${host}:${port}...`);
        const networkAvailable = await checkNetwork(host, port);
        if (!networkAvailable) {
            throw new Error(`Нет доступа к ${host}:${port}`);
        }
        console.log('✅ Сеть доступна');

        console.log('[3/4] Создание драйвера YDB...');
        const driver = new Driver({
            endpoint: `grpcs://${config.ydb.endpoint}`,
            database: config.ydb.database,
            authService: {
                getAuthMetadata: () => {
                    const metadata = new grpc.Metadata();
                    metadata.add('x-ydb-auth-ticket', config.ydb.token);
                    return metadata;
                }
            },
            grpcOptions: {
                'grpc.ssl_target_name_override': 'ydb.serverless.yandexcloud.net',
                'grpc.default_authority': 'ydb.serverless.yandexcloud.net'
            }
        });

        console.log('[4/4] Подключение к YDB...');
        if (!await driver.ready(30000)) {
            throw new Error('Таймаут подключения');
        }
        console.log('✅ YDB подключена');
        return driver;
    } catch (err) {
        console.error('❌ Ошибка подключения:', err.message);
        throw err;
    }
}

// ------ Вспомогательные функции для работы с БД ------

async function isLoginFree(driver, login) {
    // Экранируем кавычки для безопасной подстановки
    const safeLogin = login.replace(/'/g, "''");
    const query = `SELECT COUNT(*) AS cnt FROM users WHERE login = '${safeLogin}'`;
    const { resultSets } = await driver.tableClient.withSession(session => session.executeQuery(query));
    const count = Number(resultSets[0].rows[0].items[0].uint64Value);
    console.log(`DEBUG: isLoginFree('${login}') = ${count === 0 ? 'свободен' : 'занят'}`);
    return count === 0;
}

async function isEmailFree(driver, email) {
    const safeEmail = email.replace(/'/g, "''");
    const query = `SELECT COUNT(*) AS cnt FROM users WHERE email = '${safeEmail}'`;
    const { resultSets } = await driver.tableClient.withSession(session => session.executeQuery(query));
    const count = Number(resultSets[0].rows[0].items[0].uint64Value);
    console.log(`DEBUG: isEmailFree('${email}') = ${count === 0 ? 'свободен' : 'занят'}`);
    return count === 0;
}

// Функция регистрации клиента
async function registerClient(driver, userData) {
    const { login, password, fullName, phone, email } = userData;

    if (!login || login.length < 3) {
        return { success: false, error: 'Логин должен содержать не менее 3 символов' };
    }
    if (!password || password.length < 6) {
        return { success: false, error: 'Пароль должен содержать не менее 6 символов' };
    }
    if (!email || !email.includes('@')) {
        return { success: false, error: 'Некорректный email' };
    }

    const loginFree = await isLoginFree(driver, login);
    if (!loginFree) return { success: false, error: 'Логин уже занят' };

    const emailFree = await isEmailFree(driver, email);
    if (!emailFree) return { success: false, error: 'Пользователь с таким email уже зарегистрирован' };

    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();
    const role = 'client';

    // Прямая вставка (без DECLARE)
    const safeLogin = login.replace(/'/g, "''");
    const safePasswordHash = passwordHash.replace(/'/g, "''");
    const safeFullName = (fullName || '').replace(/'/g, "''");
    const safePhone = (phone || '').replace(/'/g, "''");
    const safeEmail = email.replace(/'/g, "''");
    const safeRole = role.replace(/'/g, "''");
    const safeCreatedAt = createdAt.replace(/'/g, "''");

    const insertQuery = `
        INSERT INTO users (login, password_hash, full_name, phone, email, role, created_at)
        VALUES ('${safeLogin}', '${safePasswordHash}', '${safeFullName}', '${safePhone}', '${safeEmail}', '${safeRole}', '${safeCreatedAt}')
    `;

    try {
        await driver.tableClient.withSession(session => session.executeQuery(insertQuery));
    } catch (err) {
        if (err.message && err.message.includes('Conflict with existing key')) {
            return { success: false, error: 'Логин уже занят (конфликт при вставке)' };
        }
        throw err;
    }

    return {
        success: true,
        user: { login, fullName, email, role, createdAt }
    };
}
// Функция проверки наличия препарата
async function checkAvailability(driver, productName) {
    // Экранируем одиночные кавычки для безопасной вставки в SQL
    const safeName = productName.replace(/'/g, "''");
    const query = `
        SELECT 
            p.id AS product_id,
            p.name AS product_name,
            p.retail_price,
            ph.id AS pharmacy_id,
            ph.name AS pharmacy_name,
            ph.address,
            s.quantity,
            s.reserved_quantity,
            (s.quantity - s.reserved_quantity) AS available_quantity
        FROM products AS p
        JOIN stocks AS s ON p.id = s.product_id
        JOIN pharmacies AS ph ON s.pharmacy_id = ph.id
        WHERE p.name LIKE '%${safeName}%'
        ORDER BY ph.name;
    `;

    const { resultSets } = await driver.tableClient.withSession(session =>
        session.executeQuery(query)
    );

    if (!resultSets[0].rows.length) return [];

    return resultSets[0].rows.map(row => ({
        productId: row.items[0].textValue,
        productName: row.items[1].textValue,
        price: row.items[2].doubleValue,
        pharmacyId: row.items[3].textValue,
        pharmacyName: row.items[4].textValue,
        address: row.items[5].textValue,
        quantity: row.items[6].uint64Value,
        reservedQuantity: row.items[7].uint64Value,
        availableQuantity: row.items[8].uint64Value
    }));
}
// ----- Создание Express приложения и маршрутов -----
function createApp() {
    const app = express();
    app.use(bodyParser.json());
    app.use(morgan('dev'));

    // CORS для локальной разработки
    app.use((req, res, next) => {
        const allowedOrigins = ['http://localhost', 'app://*'];
        const origin = req.headers.origin;
        if (allowedOrigins.some(o => origin?.startsWith(o))) {
            res.header('Access-Control-Allow-Origin', origin);
        }
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.header('Access-Control-Allow-Credentials', 'true');
        next();
    });

    return app;
}

function setupRoutes(app, driver) {
    // Health check
    app.get('/health', (req, res) => {
        res.json({ status: 'OK', ydbConnected: driver.ready });
    });

    // Регистрация клиента
    app.post('/api/register', async (req, res) => {
        try {
            const result = await registerClient(driver, req.body);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            console.error('Ошибка регистрации:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Проверка наличия препарата
    app.get('/api/availability', async (req, res) => {
        try {
            const { productName } = req.query;
            if (!productName) {
                return res.status(400).json({ error: 'Missing productName parameter' });
            }
            const data = await checkAvailability(driver, productName);
            res.json({ success: true, data });
        } catch (err) {
            console.error('Ошибка при поиске:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });
}

// ----- Запуск сервера -----
async function startServer() {
    try {
        validateConfig();
        const app = createApp();
        const driver = await initYDBDriver();
        setupRoutes(app, driver);

        const server = app.listen(config.port, () => {
            console.log(`🚀 Сервер запущен на порту ${config.port}`);
            console.log(`🔗 Health-check: http://localhost:${config.port}/health`);
        });

        // Graceful shutdown
        const shutdown = async () => {
            console.log('\n🛑 Завершение работы...');
            server.close(async () => {
                await driver.destroy();
                console.log('🔴 Сервер остановлен');
                process.exit(0);
            });
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    } catch (err) {
        console.error('❌ Не удалось запустить сервер:', err);
        process.exit(1);
    }
}

// Запуск, если файл выполняется напрямую
if (require.main === module) {
    startServer();
}

module.exports = { startServer, initYDBDriver, config };