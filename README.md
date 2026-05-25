# Pharmacy System Backend

Распределённая информационная система для сети аптек «Календула».

## Функции

- Регистрация клиента (POST /api/register)
- Проверка наличия препарата (GET /api/availability)

## Технологии

- Node.js, Express
- Yandex Database (YDB)
- bcrypt для хеширования паролей

## Запуск

1. Установите зависимости: `npm install`
2. Создайте файл `.env` по образцу `.env.example`
3. Запустите: `node server.js`
