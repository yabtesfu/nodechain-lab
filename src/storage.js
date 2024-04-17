'use strict';

const fs = require('fs');
const path = require('path');

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function saveSnapshot(filePath, blockchain) {
  ensureDirectory(filePath);
  fs.writeFileSync(filePath, JSON.stringify(blockchain.snapshot(), null, 2));
}

function loadSnapshot(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  saveSnapshot,
  loadSnapshot
};

