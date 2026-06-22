
CREATE DATABASE ledgerly_db;

CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    name TEXT,
    category TEXT,
    amount NUMERIC,
    type TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);