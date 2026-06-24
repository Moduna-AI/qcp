import postgres from 'postgres';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { LOCAL_SCHEMA_PATH, ensureLocalDir } from '../config/index.js';
import type { DatabaseSchema, SchemaTable, SchemaColumn, SchemaForeignKey, SchemaIndex } from '../types/index.js';

// ─── Schema scanning ──────────────────────────────────────────────────────────

export async function scanSchema(databaseUrl: string): Promise<DatabaseSchema> {
  const db = postgres(databaseUrl, {
    max: 2,
    connect_timeout: 15,
    connection: { application_name: 'qcp-schema' },
  });

  try {
    // Get database name
    const [dbRow] = await db`SELECT current_database() as name`;
    const databaseName = (dbRow as { name: string }).name;

    // Get all tables (excluding system schemas)
    const tableRows = await db`
      SELECT
        table_schema,
        table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND table_type = 'BASE TABLE'
      ORDER BY table_schema, table_name
    `;

    const tables: SchemaTable[] = [];

    for (const tableRow of tableRows) {
      const row = tableRow as { table_schema: string; table_name: string };
      const tableName = row.table_name;
      const schemaName = row.table_schema;

      // Get columns
      const columnRows = await db`
        SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          CASE
            WHEN pk.column_name IS NOT NULL THEN true
            ELSE false
          END as is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
            AND tc.table_name = kcu.table_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = ${schemaName}
            AND tc.table_name = ${tableName}
        ) pk ON c.column_name = pk.column_name
        WHERE c.table_schema = ${schemaName}
          AND c.table_name = ${tableName}
        ORDER BY c.ordinal_position
      `;

      const columns: SchemaColumn[] = columnRows.map((r) => {
        const cr = r as {
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
          is_primary_key: boolean;
        };
        return {
          name: cr.column_name,
          type: cr.data_type,
          nullable: cr.is_nullable === 'YES',
          defaultValue: cr.column_default ?? undefined,
          isPrimaryKey: cr.is_primary_key,
        };
      });

      // Get primary keys
      const primaryKeys = columns
        .filter((c) => c.isPrimaryKey)
        .map((c) => c.name);

      // Get foreign keys
      const fkRows = await db`
        SELECT
          tc.constraint_name,
          kcu.column_name,
          ccu.table_schema AS foreign_table_schema,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = ${schemaName}
          AND tc.table_name = ${tableName}
      `;

      const foreignKeys: SchemaForeignKey[] = fkRows.map((r) => {
        const fr = r as {
          constraint_name: string;
          column_name: string;
          foreign_table_schema: string;
          foreign_table_name: string;
          foreign_column_name: string;
        };
        return {
          constraintName: fr.constraint_name,
          column: fr.column_name,
          referencedTable: fr.foreign_table_name,
          referencedSchema: fr.foreign_table_schema,
          referencedColumn: fr.foreign_column_name,
        };
      });

      // Get indexes
      const indexRows = await db`
        SELECT
          i.relname AS index_name,
          ix.indisunique AS is_unique,
          ix.indisprimary AS is_primary,
          array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_index ix ON c.oid = ix.indrelid
        JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
          AND a.attnum = ANY(ix.indkey)
        JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = ${tableName}
          AND n.nspname = ${schemaName}
          AND c.relkind = 'r'
        GROUP BY i.relname, ix.indisunique, ix.indisprimary
        ORDER BY i.relname
      `;

      const indexes: SchemaIndex[] = indexRows.map((r) => {
        const ir = r as {
          index_name: string;
          is_unique: boolean;
          is_primary: boolean;
          columns: string[];
        };
        return {
          name: ir.index_name,
          columns: ir.columns,
          unique: ir.is_unique,
          primary: ir.is_primary,
        };
      });

      // Get estimated row count
      let estimatedRows: number | undefined;
      try {
        const [statRow] = await db`
          SELECT reltuples::bigint AS estimate
          FROM pg_class
          WHERE relname = ${tableName}
            AND relnamespace = (
              SELECT oid FROM pg_namespace WHERE nspname = ${schemaName}
            )
        `;
        if (statRow) {
          estimatedRows = Number((statRow as { estimate: string | number }).estimate);
        }
      } catch {
        // ignore
      }

      tables.push({
        schema: schemaName,
        name: tableName,
        columns,
        primaryKeys,
        foreignKeys,
        indexes,
        estimatedRows,
      });
    }

    return {
      scannedAt: new Date().toISOString(),
      databaseName,
      tableCount: tables.length,
      tables,
    };
  } finally {
    await db.end().catch(() => {});
  }
}

// ─── Persist / Load ────────────────────────────────────────────────────────────

export function saveSchema(schema: DatabaseSchema): void {
  ensureLocalDir();
  writeFileSync(LOCAL_SCHEMA_PATH, JSON.stringify(schema, null, 2));
}

export function loadSchema(): DatabaseSchema {
  if (!existsSync(LOCAL_SCHEMA_PATH)) {
    throw new Error(
      'Schema not found. Run: qcp schema scan\n' +
      'Make sure you are in the same directory where you ran qcp init.'
    );
  }
  const raw = readFileSync(LOCAL_SCHEMA_PATH, 'utf-8');
  return JSON.parse(raw) as DatabaseSchema;
}

// ─── Schema → LLM context ─────────────────────────────────────────────────────

/**
 * Convert schema to a compact text representation for LLM context.
 * Keeps only what the LLM needs; omits row data.
 */
export function schemaToContext(schema: DatabaseSchema, maxTables = 60): string {
  const tables = schema.tables.slice(0, maxTables);
  const lines: string[] = [
    `Database: ${schema.databaseName}`,
    `Tables (${schema.tableCount}):`,
    '',
  ];

  for (const table of tables) {
    const tableId = table.schema === 'public' ? table.name : `${table.schema}.${table.name}`;
    lines.push(`TABLE ${tableId}`);

    for (const col of table.columns) {
      const pk = col.isPrimaryKey ? ' [PK]' : '';
      const nullable = col.nullable ? ' (nullable)' : '';
      lines.push(`  ${col.name}: ${col.type}${pk}${nullable}`);
    }

    if (table.foreignKeys.length > 0) {
      for (const fk of table.foreignKeys) {
        const ref = fk.referencedSchema === 'public'
          ? fk.referencedTable
          : `${fk.referencedSchema}.${fk.referencedTable}`;
        lines.push(`  → ${fk.column} → ${ref}.${fk.referencedColumn}`);
      }
    }

    if (table.estimatedRows !== undefined && table.estimatedRows > 0) {
      lines.push(`  (~${table.estimatedRows.toLocaleString()} rows)`);
    }

    lines.push('');
  }

  if (schema.tableCount > maxTables) {
    lines.push(`... and ${schema.tableCount - maxTables} more tables`);
  }

  return lines.join('\n');
}
