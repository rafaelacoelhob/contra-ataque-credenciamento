/**
 * Identificação do evento pela listagem do portal (/accreditation/eventos/).
 * Não usa a API pública da Ligatech — só o login do portal.
 */
import { getPortal } from "./accreditation";

export interface FoundEvent {
  id: number;
  name: string;
  date?: string;
  championship?: string;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTeams(match: string): string[] {
  return match
    .split(/\s+(?:x|vs|×)\s+/i)
    .map((t) => normalize(t))
    .filter(Boolean);
}

function parseFlexibleDate(raw: string): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  // DD/MM/YYYY ou DD-MM-YYYY (ignora hora depois)
  const br = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (br) {
    const [, d, m, y] = br;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return new Date(Date.UTC(year, Number(m) - 1, Number(d)));
  }
  const iso = new Date(s);
  return isNaN(iso.getTime()) ? null : iso;
}

function sameDay(a: string, b: string): boolean {
  const pa = parseFlexibleDate(a);
  const pb = parseFlexibleDate(b);
  if (!pa || !pb) return false;
  return (
    pa.getUTCFullYear() === pb.getUTCFullYear() &&
    pa.getUTCMonth() === pb.getUTCMonth() &&
    pa.getUTCDate() === pb.getUTCDate()
  );
}

export interface FindEventCriteria {
  match: string;
  date: string;
  /** Nome do campeonato na planilha (ex: "Paulistão A1") — desempata quando
   *  o mesmo confronto acontece no mesmo dia em mais de uma categoria. */
  competition?: string;
}

/**
 * Quantas palavras do campeonato da planilha aparecem no campeonato do portal.
 * Compara por prefixo pra "Paulistão" casar com "PAULISTA".
 */
function competitionScore(sheetComp: string, portalComp?: string): number {
  if (!sheetComp || !portalComp) return 0;
  const hayTokens = normalize(portalComp).split(" ");
  const tokens = normalize(sheetComp).split(" ").filter((t) => t.length > 1);
  return tokens.filter((t) =>
    hayTokens.some(
      (h) =>
        h === t ||
        (t.length >= 5 && h.startsWith(t.slice(0, 5))) ||
        (h.length >= 5 && t.startsWith(h.slice(0, 5))),
    ),
  ).length;
}

/**
 * Procura o evento que casa com confronto+data da planilha.
 * Filtra a listagem do portal pelo nome de cada time; se nada vier,
 * varre as primeiras páginas sem filtro. Havendo mais de um candidato
 * (mesmo confronto em categorias diferentes), prefere o de campeonato
 * mais parecido com o da planilha.
 */
export async function findEventByMatch(
  criteria: FindEventCriteria,
): Promise<FoundEvent | null> {
  const portal = getPortal();
  if (!portal) return null;

  const teams = splitTeams(criteria.match);
  if (teams.length < 2) return null;

  const rawTeams = criteria.match
    .split(/\s+(?:x|vs|×)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);

  const seen = new Map<number, FoundEvent>();
  for (const filter of [...rawTeams, undefined]) {
    const eventos = await portal.listEventos(filter);
    for (const ev of eventos) seen.set(ev.id, ev);

    const matches = [...seen.values()].filter((ev) => {
      if (ev.date && criteria.date && !sameDay(ev.date, criteria.date)) return false;
      return teams.every((t) => normalize(ev.name).includes(t));
    });
    if (matches.length > 0) {
      matches.sort((a, b) => {
        const sa = competitionScore(criteria.competition ?? "", a.championship);
        const sb = competitionScore(criteria.competition ?? "", b.championship);
        if (sa !== sb) return sb - sa; // campeonato mais parecido primeiro
        const da = parseFlexibleDate(a.date ?? "")?.getTime() ?? Infinity;
        const db = parseFlexibleDate(b.date ?? "")?.getTime() ?? Infinity;
        return da - db;
      });
      return matches[0];
    }
  }
  return null;
}
