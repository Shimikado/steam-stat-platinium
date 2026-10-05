import fs from 'node:fs';
import path from 'node:path';
import { hasDb, kvGet, kvSet } from './db.js';

/**
 * Cache clé/valeur avec expiration, sur trois niveaux :
 * mémoire → base Postgres (si `ns` et DATABASE_URL) → fichier disque (si `file`).
 * La base fait survivre le cache aux redémarrages de l'hébergeur, dont le disque est effacé.
 */
export class TtlCache {
  constructor({ ttlMs, file = null, ns = null }) {
    this.ttlMs = ttlMs;
    this.file = file;
    this.ns = ns;
    this.map = new Map();
    this.saveTimer = null;
    this.#load();
  }

  #memory(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.t > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.v;
  }

  /** Valeur en cache ou undefined (null est une valeur valide, ex. « jeu sans succès »). */
  async get(key) {
    const local = this.#memory(key);
    if (local !== undefined || !this.ns || !hasDb()) return local;
    try {
      const stored = await kvGet(this.ns, String(key), this.ttlMs);
      if (stored !== undefined) this.map.set(key, { t: Date.now(), v: stored });
      return stored;
    } catch {
      return undefined; // base injoignable : on refait simplement l'appel à Steam
    }
  }

  set(key, value) {
    this.map.set(key, { t: Date.now(), v: value });
    if (this.ns) kvSet(this.ns, String(key), value);
    this.#scheduleSave();
  }

  #load() {
    if (!this.file) return;
    try {
      const entries = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [k, e] of entries) {
        if (now - e.t <= this.ttlMs) this.map.set(k, e);
      }
    } catch {
      // Pas de cache existant ou fichier illisible : on repart de zéro.
    }
  }

  #scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify([...this.map]));
      } catch (err) {
        console.warn(`Impossible d'écrire le cache ${this.file}:`, err.message);
      }
    }, 2000);
  }
}
