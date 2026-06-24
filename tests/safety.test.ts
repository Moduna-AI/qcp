import { describe, it, expect } from 'bun:test';
import { validateSql } from '../src/safety/index.js';

// ─── Safe queries ─────────────────────────────────────────────────────────────

describe('Safe queries — should PASS', () => {
  it('simple SELECT', () => {
    const r = validateSql('SELECT * FROM users');
    expect(r.safe).toBe(true);
    expect(r.allowedStatement).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('SELECT with WHERE', () => {
    const r = validateSql("SELECT id, name FROM customers WHERE active = true");
    expect(r.safe).toBe(true);
  });

  it('SELECT with LIMIT already present', () => {
    const r = validateSql('SELECT * FROM orders LIMIT 10');
    expect(r.safe).toBe(true);
    expect(r.limitApplied).toBe(false); // LIMIT already present
  });

  it('SELECT with JOIN', () => {
    const r = validateSql(`
      SELECT c.name, SUM(o.total) as revenue
      FROM customers c
      JOIN orders o ON c.id = o.customer_id
      GROUP BY c.name
      ORDER BY revenue DESC
    `);
    expect(r.safe).toBe(true);
  });

  it('EXPLAIN query', () => {
    const r = validateSql('EXPLAIN SELECT * FROM users');
    expect(r.safe).toBe(true);
    expect(r.statementType).toBe('explain');
  });

  it('CTE (WITH) query', () => {
    const r = validateSql(`
      WITH monthly AS (
        SELECT customer_id, SUM(total) as rev
        FROM orders
        WHERE created_at >= '2024-01-01'
        GROUP BY customer_id
      )
      SELECT * FROM monthly ORDER BY rev DESC
    `);
    expect(r.safe).toBe(true);
    expect(r.statementType).toBe('with');
  });
});

// ─── Dangerous queries ────────────────────────────────────────────────────────

describe('Dangerous queries — should FAIL', () => {
  it('DELETE query', () => {
    const r = validateSql('DELETE FROM users WHERE id = 1');
    expect(r.safe).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toMatch(/DELETE/i);
  });

  it('INSERT query', () => {
    const r = validateSql("INSERT INTO users (name) VALUES ('hack')");
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/INSERT/i);
  });

  it('UPDATE query', () => {
    const r = validateSql("UPDATE users SET name = 'hacked' WHERE id = 1");
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/UPDATE/i);
  });

  it('DROP TABLE', () => {
    const r = validateSql('DROP TABLE users');
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/DROP/i);
  });

  it('TRUNCATE', () => {
    const r = validateSql('TRUNCATE TABLE orders');
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/TRUNCATE/i);
  });

  it('CREATE TABLE', () => {
    const r = validateSql('CREATE TABLE evil (id serial)');
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/CREATE/i);
  });

  it('ALTER TABLE', () => {
    const r = validateSql('ALTER TABLE users ADD COLUMN hack text');
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/ALTER/i);
  });

  it('GRANT privileges', () => {
    const r = validateSql('GRANT ALL ON users TO hacker');
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/GRANT/i);
  });

  it('multiple statements', () => {
    const r = validateSql('SELECT * FROM users; DELETE FROM users');
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/multiple/i);
  });

  it('empty query', () => {
    const r = validateSql('');
    expect(r.safe).toBe(false);
    expect(r.errors[0]).toMatch(/empty/i);
  });
});

// ─── LIMIT injection ──────────────────────────────────────────────────────────

describe('LIMIT injection', () => {
  it('injects LIMIT 100 when missing', () => {
    const r = validateSql('SELECT * FROM users');
    expect(r.safe).toBe(true);
    expect(r.limitApplied).toBe(true);
    expect(r.processedSql).toMatch(/LIMIT 100/i);
  });

  it('does NOT inject LIMIT when already present', () => {
    const r = validateSql('SELECT * FROM users LIMIT 50');
    expect(r.limitApplied).toBe(false);
    expect(r.processedSql).not.toMatch(/LIMIT 100/i);
    expect(r.processedSql).toMatch(/LIMIT 50/i);
  });

  it('does not inject LIMIT for EXPLAIN', () => {
    const r = validateSql('EXPLAIN SELECT * FROM users');
    expect(r.limitApplied).toBe(false);
  });

  it('processed SQL has no trailing semicolon', () => {
    const r = validateSql('SELECT id FROM users;');
    expect(r.safe).toBe(true);
    expect(r.processedSql).not.toMatch(/;/);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('handles SQL with leading/trailing whitespace', () => {
    const r = validateSql('  \n  SELECT * FROM orders  \n  ');
    expect(r.safe).toBe(true);
  });

  it('handles complex subquery', () => {
    const r = validateSql(`
      SELECT *
      FROM orders
      WHERE customer_id IN (
        SELECT id FROM customers WHERE country = 'US'
      )
    `);
    expect(r.safe).toBe(true);
  });

  it('handles window functions', () => {
    const r = validateSql(`
      SELECT name, revenue,
        ROW_NUMBER() OVER (ORDER BY revenue DESC) as rank
      FROM customers
    `);
    expect(r.safe).toBe(true);
  });
});
