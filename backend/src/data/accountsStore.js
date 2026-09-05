/**
 * Registro de clientes/contas geridas pela agência — agora persistido
 * num arquivo JSON de verdade (accounts.json, na mesma pasta), em vez de
 * um array que reseta toda vez que o servidor reinicia.
 *
 * Isso ainda não é um banco de dados de verdade (Postgres/SQLite) — é um
 * degrau intermediário: já sobrevive a reiniciar o servidor, mas não
 * aguenta múltiplas pessoas editando ao mesmo tempo nem consultas
 * complexas. Trocar por um banco de verdade no futuro é só reescrever
 * as 4 funções abaixo (load/save/etc.) — o resto do código nem percebe.
 */

const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, 'accounts.json');

function load() {
  if (!fs.existsSync(FILE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function save(accounts) {
  fs.writeFileSync(FILE_PATH, JSON.stringify(accounts, null, 2), 'utf-8');
}

function getAll() {
  return load();
}

function add(account) {
  const accounts = load();
  accounts.push(account);
  save(accounts);
  return account;
}

function update(id, changes) {
  const accounts = load();
  const account = accounts.find((a) => a.id === id);
  if (!account) return null;
  Object.assign(account, changes);
  save(accounts);
  return account;
}

function remove(id) {
  const accounts = load();
  const filtered = accounts.filter((a) => a.id !== id);
  save(filtered);
  return filtered.length !== accounts.length;
}

module.exports = { getAll, add, update, remove };
