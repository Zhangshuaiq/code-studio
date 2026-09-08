const test = require('node:test');
const assert = require('node:assert/strict');
const { classifySql } = require('../dist/db-query/db-query.service.js');

test('database reads do not require approval', () => {
  for (const sql of ['SELECT * FROM users', 'SHOW TABLES', 'EXPLAIN SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x']) {
    assert.equal(classifySql(sql).requiresApproval, false, sql);
  }
});

test('database writes and DDL require approval', () => {
  for (const sql of ['CREATE TABLE x(id int)', 'INSERT INTO x VALUES (1)', 'UPDATE x SET id=2', 'DELETE FROM x', 'DROP TABLE x', 'WITH x AS (SELECT 1) DELETE FROM users', "SELECT * FROM x INTO OUTFILE '/tmp/x'", 'SELECT * FROM x FOR UPDATE']) {
    assert.equal(classifySql(sql).requiresApproval, true, sql);
  }
  assert.equal(classifySql('SELECT 1; DELETE FROM users').requiresApproval, true);
});
