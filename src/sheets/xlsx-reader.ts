/**
 * Leitor da planilha de credenciamento da Contra Ataque.
 *
 * Formato (aba única, nome variável):
 *   - Topo: linhas com rótulos na coluna B —
 *       "Transmissão:  Paulistão A1 - Santos x São Paulo"
 *       "Data da Transmissão: 13_08_2026 - UM17"
 *       "Local: Estádio ..." / "Horário: Quinta-feira, 19h"
 *   - Cabeçalho da lista: NOME | FUNÇÃO | RG | CPF (a coluna de zona vem
 *     depois do CPF, sem título)
 *   - A lista pode ter blocos ("Operacional") e uma tabela de carros/placas
 *     no fim — linhas sem CPF válido são ignoradas.
 *
 * O leitor não assume posição fixa: acha o cabeçalho e mapeia as colunas
 * pelos títulos, e a coluna de zona pelo conteúdo ("zona ...").
 */
import * as XLSX from "xlsx";

export interface EventInfo {
  name: string;
  date: string;
  match: string;
  time: string;
  venue: string;
}

export interface SheetRow {
  name: string;
  cpf: string;
  cpfValid: boolean;
  role: string;
  zoneSlug: string;
  supplier?: string;
}

export interface CredentialInputRow {
  cpf: string;
  zoneSlug: string;
}

function zoneToSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeCpf(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 11) return null;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

function getSheet(buffer: Buffer): XLSX.WorkSheet {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Planilha vazia ou inválida.");
  return wb.Sheets[sheetName];
}

function readAllRows(ws: XLSX.WorkSheet): string[][] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: "",
    raw: false,
    range: "A1:L10000",
  });
  return rows.map((r) => r.map((c) => String(c ?? "").trim()));
}

// ── Informações do jogo ──────────────────────────────────────────────────────

/** Procura "Rótulo: valor" em qualquer célula das primeiras linhas. */
function findLabeled(rows: string[][], label: RegExp, maxRows = 20): string {
  for (let i = 0; i < Math.min(rows.length, maxRows); i++) {
    for (const cell of rows[i]) {
      const m = cell.match(label);
      if (m?.[1]) return m[1].trim();
    }
  }
  return "";
}

/**
 * Lê os dados do jogo das linhas rotuladas do topo.
 * "Transmissão: Paulistão A1 - Santos x São Paulo" vira
 * name="Paulistão A1" e match="Santos x São Paulo".
 */
export function readEventInfoFromBuffer(buffer: Buffer): EventInfo {
  const rows = readAllRows(getSheet(buffer));

  const transmissao = findLabeled(rows, /Transmiss[ãa]o:\s*(.+)/i);
  let name = transmissao;
  let match = "";
  // Separa "campeonato - confronto": o pedaço com " x " é o confronto
  const parts = transmissao.split(/\s+[-–]\s+/);
  const matchPart = parts.find((p) => /\s+x\s+/i.test(p));
  if (matchPart) {
    match = matchPart.trim();
    name = parts.filter((p) => p !== matchPart).join(" - ").trim();
  } else if (/\s+x\s+/i.test(transmissao)) {
    match = transmissao;
  }

  // "13_08_2026 - UM17" → "13/08/2026"
  const dataRaw = findLabeled(rows, /Data[^:]*:\s*([0-9][0-9_.\/-]+)/i);
  const date = dataRaw.replace(/[_.]/g, "/");

  return {
    name,
    date,
    match,
    time: findLabeled(rows, /Hor[áa]rio:\s*(.+)/i),
    venue: findLabeled(rows, /Local:\s*(.+)/i),
  };
}

// ── Lista de pessoas ─────────────────────────────────────────────────────────

interface ColumnMap {
  headerIdx: number;
  nameCol: number;
  roleCol: number;
  cpfCol: number;
  zoneCol: number;
}

function mapColumns(rows: string[][]): ColumnMap {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const row = rows[i];
    const nameCol = row.findIndex((c) => /^nome/i.test(c));
    const cpfCol = row.findIndex((c) => /^cpf/i.test(c));
    if (nameCol === -1 || cpfCol === -1) continue;

    const roleCol = row.findIndex((c) => /^fun[çc][ãa]o/i.test(c));

    // Coluna de zona não tem título: procura nos dados a coluna (depois do
    // CPF) onde aparecem valores "zona ..."
    let zoneCol = -1;
    const votes = new Map<number, number>();
    for (let j = i + 1; j < Math.min(rows.length, i + 60); j++) {
      rows[j].forEach((cell, col) => {
        if (col > cpfCol && /^zona\s/i.test(cell)) {
          votes.set(col, (votes.get(col) ?? 0) + 1);
        }
      });
    }
    for (const [col, n] of votes) {
      if (zoneCol === -1 || n > (votes.get(zoneCol) ?? 0)) zoneCol = col;
    }
    if (zoneCol === -1) zoneCol = cpfCol + 1;

    return {
      headerIdx: i,
      nameCol,
      roleCol: roleCol !== -1 ? roleCol : nameCol + 1,
      cpfCol,
      zoneCol,
    };
  }
  throw new Error(
    'Cabeçalho não encontrado — a planilha precisa ter uma linha com as colunas "NOME" e "CPF".',
  );
}

/**
 * Lê todas as pessoas da lista (inclusive blocos como "Operacional").
 * Linhas sem nome ou sem CPF (títulos de seção, carros/placas, vazias)
 * ficam de fora.
 */
export function readSheetListFromBuffer(buffer: Buffer): SheetRow[] {
  const rows = readAllRows(getSheet(buffer));
  const cols = mapColumns(rows);

  const out: SheetRow[] = [];
  for (let i = cols.headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = row[cols.nameCol] ?? "";
    const rawCpf = row[cols.cpfCol] ?? "";
    if (!name || !rawCpf) continue;

    const normalized = normalizeCpf(rawCpf);
    if (!normalized) {
      console.warn(`[xlsx-reader] CPF inválido para "${name}": "${rawCpf}"`);
    }
    out.push({
      name,
      cpf: normalized ?? rawCpf,
      cpfValid: normalized !== null,
      role: row[cols.roleCol] ?? "",
      zoneSlug: zoneToSlug(row[cols.zoneCol] ?? ""),
      supplier: undefined,
    });
  }
  return out;
}

export function rowsToCredentialInputs(rows: SheetRow[]): CredentialInputRow[] {
  return rows
    .filter((r) => r.zoneSlug && r.cpfValid)
    .map((r) => ({ cpf: r.cpf, zoneSlug: r.zoneSlug }));
}

/**
 * Inspeção da leitura: mapeamento de colunas detectado, totais e amostra.
 * Serve para diagnosticar quando o resultado vem 0/0/0.
 */
export function debugReadSheetFromBuffer(buffer: Buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const rows = readAllRows(wb.Sheets[sheetName]);
  const cols = mapColumns(rows);
  const parsed = readSheetListFromBuffer(buffer);

  return {
    availableSheets: wb.SheetNames,
    chosenSheet: sheetName,
    columnMap: cols,
    headerRow: rows[cols.headerIdx],
    parsedFinal: parsed.length,
    validos: parsed.filter((r) => r.cpfValid && r.zoneSlug).length,
    parsedSample: parsed.slice(0, 5),
    eventInfo: readEventInfoFromBuffer(buffer),
  };
}
