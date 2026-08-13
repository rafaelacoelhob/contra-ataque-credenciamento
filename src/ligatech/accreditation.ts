/**
 * Credenciamento via portal staff.ligatech.com.br — versão portal-only.
 * Exige LIGATECH_PORTAL_USERNAME e LIGATECH_PORTAL_PASSWORD no ambiente.
 */
import { PortalClient } from "./portal-client";

// Singleton lazy do cliente do portal (mantém cookie de sessão entre requests)
let portalSingleton: PortalClient | null = null;
export function getPortal(): PortalClient | null {
  const username = process.env.LIGATECH_PORTAL_USERNAME;
  const password = process.env.LIGATECH_PORTAL_PASSWORD;
  if (!username || !password) return null;
  if (!portalSingleton) {
    portalSingleton = new PortalClient({ username, password });
  }
  return portalSingleton;
}

export interface CredentialInput {
  cpf: string;
  zoneSlug: string;
}

export type CredentialStatus =
  | "success"
  | "cpf_nao_cadastrado"
  | "erro_api"
  | "cpf_invalido";

export type CheckStatus =
  | "credenciado"
  | "pre_credenciado"
  | "nao_solicitado"
  | "pessoa_nao_encontrada"
  | "cpf_invalido"
  | "erro_api";

export interface CheckItemResult {
  cpf: string;
  name?: string;
  zoneSlug: string;
  status: CheckStatus;
  message?: string;
}

export interface CredentialItemResult {
  cpf: string;
  name?: string;
  zoneSlug: string;
  status: CredentialStatus;
  message?: string;
  raw?: unknown;
}

function validateCpf(cpf: string): boolean {
  const cleaned = cpf.replace(/\D/g, "");
  return cleaned.length === 11;
}

/** Solicita o credenciamento de uma pessoa numa zona do evento. */
export async function makePreCredential(
  eventId: number,
  input: CredentialInput,
): Promise<CredentialItemResult> {
  const { cpf, zoneSlug } = input;

  if (!validateCpf(cpf)) {
    return { cpf, zoneSlug, status: "cpf_invalido", message: "CPF com formato inválido" };
  }

  const portal = getPortal();
  if (!portal) {
    return {
      cpf,
      zoneSlug,
      status: "erro_api",
      message: "Configure LIGATECH_PORTAL_USERNAME e LIGATECH_PORTAL_PASSWORD",
    };
  }

  try {
    const zoneId = await portal.resolveZoneId(eventId, zoneSlug);
    if (!zoneId) {
      return {
        cpf,
        zoneSlug,
        status: "erro_api",
        message: `Zona "${zoneSlug}" não encontrada nas zonas do evento ${eventId}`,
      };
    }
    const r = await portal.solicitarCredencial(eventId, zoneId, cpf);
    if (r.status === "success") {
      return { cpf, zoneSlug, status: "success", message: r.message, raw: r };
    }
    if (r.status === "person_not_found") {
      return {
        cpf,
        zoneSlug,
        status: "cpf_nao_cadastrado",
        message: r.message ?? "Pessoa não encontrada nessa zona",
      };
    }
    if (r.status === "no_position") {
      return {
        cpf,
        zoneSlug,
        status: "cpf_nao_cadastrado",
        message: r.message ?? "Sem vaga liberada nessa zona",
      };
    }
    return { cpf, zoneSlug, status: "erro_api", message: r.message ?? "Erro no portal", raw: r };
  } catch (e: any) {
    return { cpf, zoneSlug, status: "erro_api", message: `Portal: ${e?.message ?? e}` };
  }
}

/** Verifica o status de credenciamento (sem solicitar nada). */
export async function checkCredential(
  eventId: number,
  input: CredentialInput,
): Promise<CheckItemResult> {
  const { cpf, zoneSlug } = input;
  if (!validateCpf(cpf)) {
    return { cpf, zoneSlug, status: "cpf_invalido", message: "CPF com formato inválido" };
  }
  const portal = getPortal();
  if (!portal) {
    return {
      cpf,
      zoneSlug,
      status: "erro_api",
      message: "Configure LIGATECH_PORTAL_USERNAME e LIGATECH_PORTAL_PASSWORD",
    };
  }
  try {
    const zoneId = await portal.resolveZoneId(eventId, zoneSlug);
    if (!zoneId) {
      return {
        cpf,
        zoneSlug,
        status: "erro_api",
        message: `Zona "${zoneSlug}" não encontrada nas zonas do evento ${eventId}`,
      };
    }
    const r = await portal.checkCredencial(eventId, zoneId, cpf);
    if (r.status === "error") {
      return { cpf, zoneSlug, status: "erro_api", message: r.message };
    }
    return { cpf, zoneSlug, status: r.status, message: r.message };
  } catch (e: any) {
    return { cpf, zoneSlug, status: "erro_api", message: `Portal: ${e?.message ?? e}` };
  }
}
