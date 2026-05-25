
const { checkAvailability } = require('./services/searchService');
const { registerClient, login } = require('./services/authService');

async function main() {
    console.log('=== Проверка наличия препарата ===');
    const availability = await checkAvailability('Аспирин');
    console.log(availability);
    
    console.log('\n=== Регистрация клиента ===');
    const registration = await registerClient({
        login: 'ivan123',
        password: 'pass123',
        firstName: 'Иван',
        lastName: 'Иванов',
        phone: '+79161234567',
        email: 'ivan@example.com'
    });
    console.log(registration);
}

main();