const mysql = require('mysql2/promise');
const config = require('../config');

/**
 * Pool de conexões com o banco MySQL da Hostinger.
 *
 * Por que trocar o arquivo JSON por um banco de verdade: o arquivo
 * (accounts.json) vivia dentro da mesma pasta que o Git publica — e
 * toda vez que a Hostinger reimplanta o app a partir do repositório,
 * ela limpa arquivos que não estão no Git, apagando os clientes
 * cadastrados. Um banco de dados existe separado do código, então
 * nenhum deploy futuro consegue apagá-lo.
 */

let pool = null;
function getPool() {
  if (!pool) {
    if (!config.db.host) {
      throw new Error(
        'Banco de dados não configurado. Defina DB_HOST, DB_USER, DB_PASSWORD e DB_NAME no .env ' +
        '(crie o banco em hPanel → Banco de dados).'
      );
    }
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.name,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return pool;
}

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(191) PRIMARY KEY,
        data JSON NOT NULL
      )
    `);
  }
  return tableReady;
}

module.exports = { getPool, ensureTable };
