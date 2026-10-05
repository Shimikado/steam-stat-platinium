import fs from 'node:fs';
import path from 'node:path';

/**
 * Petit cache clé/valeur avec expiration, optionnellement persisté sur disque
 * pour ne pas re-scanner toute une bibliothèque à chaque redémarrage.
 */
export class TtlCache {
  constructor({ ttlMs, file = null }) {
    this.ttlMs = ttlMs;
    this.file = file;
    this.map = new Map();
    this.saveTimer = null;
    this.#load();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.t > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.v;
  }

  set(key, value) {
    this.map.set(key, { t: Date.now(), v: value });
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
