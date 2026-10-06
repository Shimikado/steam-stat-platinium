import { addUsage, getUsage } from './db.js';

// Compteur d'appels à la Web API Steam (limite : 100 000 par jour et par clé).
// Au-delà du budget, on refuse les nouveaux appels plutôt que de faire bloquer la clé.

const LIMIT = 100000;
const today = () => new Date().toISOString().slice(0, 10); // jour UTC

let day = today();
let calls = 0;
let pending = 0;
let flushTimer = null;

const budget = () => Number(process.env.STEAM_DAILY_BUDGET) || 95000;

function roll() {
  const d = today();
  if (d !== day) {
    flush();
    day = d;
    calls = 0;
  }
}

function flush() {
  flushTimer = null;
  const n = pending;
  pending = 0;
  addUsage(day, n).catch(() => {});
}

/** À appeler une fois la base prête : reprend le compte du jour après un redémarrage. */
export async function loadUsage() {
  try {
    calls = await getUsage(day);
  } catch {
    // compteur local uniquement
  }
}

export function countCall() {
  roll();
  calls++;
  pending++;
  if (calls % 1000 === 0) console.log(`Appels Steam aujourd'hui : ${calls}`);
  flushTimer ??= setTimeout(flush, 30000);
}

export function overBudget() {
  roll();
  return calls >= budget();
}

export function usage() {
  roll();
  return { day, calls, budget: budget(), limit: LIMIT };
}
