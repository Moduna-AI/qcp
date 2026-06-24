import { describe, it, expect } from 'bun:test';
import { schemaToContext } from '../src/schema/index.js';
import type { DatabaseSchema } from '../src/types/index.js';

const mockSchema: DatabaseSchema = {
  scannedAt: new Date().toISOString(),
  databaseName: 'testdb',
  tableCount: 2,
  tables: [
    {
      schema: 'public',
      name: 'customers',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
        { name: 'name', type: 'text', nullable: false, isPrimaryKey: false },
        { name: 'email', type: 'text', nullable: false, isPrimaryKey: false },
        { name: 'created_at', type: 'timestamp', nullable: false, isPrimaryKey: false },
      ],
      primaryKeys: ['id'],
      foreignKeys: [],
      indexes: [
        { name: 'customers_pkey', columns: ['id'], unique: true, primary: true },
      ],
      estimatedRows: 50000,
    },
    {
      schema: 'public',
      name: 'orders',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: true },
        { name: 'customer_id', type: 'uuid', nullable: false, isPrimaryKey: false },
        { name: 'total', type: 'numeric', nullable: false, isPrimaryKey: false },
        { name: 'created_at', type: 'timestamp', nullable: false, isPrimaryKey: false },
      ],
      primaryKeys: ['id'],
      foreignKeys: [
        {
          constraintName: 'orders_customer_id_fkey',
          column: 'customer_id',
          referencedTable: 'customers',
          referencedSchema: 'public',
          referencedColumn: 'id',
        },
      ],
      indexes: [
        { name: 'orders_pkey', columns: ['id'], unique: true, primary: true },
      ],
      estimatedRows: 250000,
    },
  ],
};

describe('schemaToContext', () => {
  it('includes database name', () => {
    const ctx = schemaToContext(mockSchema);
    expect(ctx).toContain('testdb');
  });

  it('includes table names', () => {
    const ctx = schemaToContext(mockSchema);
    expect(ctx).toContain('customers');
    expect(ctx).toContain('orders');
  });

  it('includes column names and types', () => {
    const ctx = schemaToContext(mockSchema);
    expect(ctx).toContain('id');
    expect(ctx).toContain('uuid');
    expect(ctx).toContain('total');
    expect(ctx).toContain('numeric');
  });

  it('marks primary keys', () => {
    const ctx = schemaToContext(mockSchema);
    expect(ctx).toContain('[PK]');
  });

  it('includes foreign key relationships', () => {
    const ctx = schemaToContext(mockSchema);
    expect(ctx).toContain('customer_id');
    expect(ctx).toContain('→');
  });

  it('includes estimated row counts', () => {
    const ctx = schemaToContext(mockSchema);
    expect(ctx).toContain('50,000');
    expect(ctx).toContain('250,000');
  });

  it('respects maxTables limit', () => {
    const bigSchema: DatabaseSchema = {
      ...mockSchema,
      tableCount: 5,
      tables: Array.from({ length: 5 }, (_, i) => ({
        ...mockSchema.tables[0],
        name: `table_${i}`,
      })),
    };

    const ctx = schemaToContext(bigSchema, 3);
    expect(ctx).toContain('table_0');
    expect(ctx).toContain('table_1');
    expect(ctx).toContain('table_2');
    expect(ctx).toContain('2 more tables');
  });

  it('handles schema-qualified table names', () => {
    const schemaWithNonPublic: DatabaseSchema = {
      ...mockSchema,
      tables: [
        { ...mockSchema.tables[0], schema: 'analytics' },
      ],
    };
    const ctx = schemaToContext(schemaWithNonPublic);
    expect(ctx).toContain('analytics.customers');
  });
});
