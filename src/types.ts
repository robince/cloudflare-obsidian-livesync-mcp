export type JsonObject = Record<string, unknown>;

export type AppEnv = Env & { COUCHDB_PASSWORD: string };

export interface CouchErrorBody {
  error: string;
  reason: string;
}

export interface DatabaseInfo {
  db_name: string;
  doc_count: number;
  doc_del_count: number;
  update_seq: number | string;
  purge_seq: number;
  compact_running: boolean;
  disk_format_version: number;
  instance_start_time: string;
  sizes: { file: number; external: number; active: number };
}
