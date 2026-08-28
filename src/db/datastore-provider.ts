import type { DataStore } from "./datastore.js";
import { SupabaseDataStore } from "./supabase-datastore.js";

let _defaultDataStore: DataStore | null = null;

export function getDataStore(): DataStore {
  if (!_defaultDataStore) {
    _defaultDataStore = new SupabaseDataStore();
  }
  return _defaultDataStore;
}

export function setDataStore(store: DataStore): void {
  _defaultDataStore = store;
}
