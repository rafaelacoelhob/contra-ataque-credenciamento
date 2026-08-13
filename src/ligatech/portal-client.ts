/**
 * Cliente do portal staff.ligatech.com.br
 *
 * A credenciadora faz o credenciamento manualmente pelo portal: é um Django
 * com login email+senha. Esse cliente automatiza esse fluxo.
 *
 * Fluxo:
 *   1. Login: GET /login/ → CSRF token, POST /login/ → cookie de sessão
 *   2. Resolver personId: GET /accreditation/evento/{eventId}/zona/{zoneId}/?cpf={cpf}
 *      → parsear HTML pra achar action="/.../credenciar/{personId}/"
 *   3. Solicitar: POST /accreditation/evento/{eventId}/zona/{zoneId}/credenciar/{personId}/
 *      com csrfmiddlewaretoken + cpf (form-urlencoded). 302 = sucesso.
 */

import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";

const PORTAL_BASE = "https://staff.ligatech.com.br";

export interface PortalCredentials {
  username: string;
  password: string;
}

export interface PortalZone {
  id: number;
  name: string;
  slug: string;
}

function nameToSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export interface PortalEvent {
  id: number;
  name: string;
  /** Como aparece no portal, ex: "13/08/2026 15:00" */
  date?: string;
  venue?: string;
  championship?: string;
}

export interface SolicitacaoResult {
  status: "success" | "person_not_found" | "no_position" | "error";
  message?: string;
  personId?: number;
  redirectLocation?: string;
}

export interface CheckResult {
  status: "credenciado" | "pre_credenciado" | "nao_solicitado" | "pessoa_nao_encontrada" | "error";
  message?: string;
  personId?: number;
}

export class PortalClient {
  private jar = new CookieJar();
  private http: AxiosInstance;
  private loggedIn = false;
  private creds: PortalCredentials;

  constructor(creds: PortalCredentials) {
    this.creds = creds;
    this.http = wrapper(
      axios.create({
        baseURL: PORTAL_BASE,
        jar: this.jar,
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; ContraAtaqueCredenciamento/1.0)",
        },
      } as any),
    );
  }

  /** Faz login. Salva cookie de sessão no jar. */
  async login(): Promise<void> {
    // 1. GET /login/ pra obter CSRF do form
    const loginPage = await this.http.get("/login/");
    if (loginPage.status !== 200) {
      throw new Error(`GET /login/ falhou (HTTP ${loginPage.status})`);
    }
    const csrf = extractFormCsrf(loginPage.data);
    if (!csrf) throw new Error("CSRF token não encontrado na página de login");

    // 2. POST /login/
    const params = new URLSearchParams();
    params.set("csrfmiddlewaretoken", csrf);
    params.set("username", this.creds.username);
    params.set("password", this.creds.password);
    params.set("checkbox-fill-1", "on");
    params.set("login", "");

    const post = await this.http.post("/login/", params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${PORTAL_BASE}/login/`,
        Origin: PORTAL_BASE,
      },
    });

    // Sucesso: redirect (com follow-redirect, terminamos no dashboard com 200)
    const finalUrl = (post.request?.res?.responseUrl as string) ?? "";
    const html = String(post.data ?? "");
    if (post.status >= 400) {
      throw new Error(`Login falhou (HTTP ${post.status})`);
    }
    if (!finalUrl.includes("/dashboard") && !/Logout|Sair/i.test(html)) {
      throw new Error("Login aparentemente falhou — sem dashboard nem Logout no HTML");
    }
    this.loggedIn = true;
  }

  /**
   * Lista eventos visíveis no portal (/accreditation/eventos/), com filtro
   * opcional por nome de time (busca "contains" do próprio portal).
   * Permite identificar o evento sem depender da API pública — útil quando
   * a empresa não tem LIGATECH_API_KEY.
   */
  async listEventos(nameFilter?: string, maxPages = 5): Promise<PortalEvent[]> {
    if (!this.loggedIn) await this.login();

    const out: PortalEvent[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const params: Record<string, string | number> = {};
      if (nameFilter) params.name = nameFilter;
      if (page > 1) params.page = page;

      let r = await this.http.get("/accreditation/eventos/", { params });
      if (r.status === 302 || /input[^>]+name="username"/.test(String(r.data))) {
        this.loggedIn = false;
        await this.login();
        r = await this.http.get("/accreditation/eventos/", { params });
      }
      if (r.status !== 200) break;

      const found = parseEventosPage(String(r.data ?? ""));
      out.push(...found);
      if (found.length < 10) break; // página incompleta = última
    }
    // dedup por id (paginação pode repetir na borda)
    return [...new Map(out.map((e) => [e.id, e])).values()];
  }

  /**
   * Lista as zonas de um evento (com id numérico e nome).
   * Cacheia em memória pra evitar refazer GET a cada solicitação.
   */
  private zonasCache = new Map<number, { at: number; zonas: PortalZone[] }>();
  private static ZONAS_TTL_MS = 5 * 60 * 1000;

  async listZonas(eventId: number): Promise<PortalZone[]> {
    const cached = this.zonasCache.get(eventId);
    if (cached && Date.now() - cached.at < PortalClient.ZONAS_TTL_MS) {
      return cached.zonas;
    }
    if (!this.loggedIn) await this.login();

    let r = await this.http.get(`/accreditation/evento/${eventId}/zonas/`);
    if (r.status === 302 || /input[^>]+name="username"/.test(String(r.data))) {
      this.loggedIn = false;
      await this.login();
      r = await this.http.get(`/accreditation/evento/${eventId}/zonas/`);
    }
    if (r.status !== 200) {
      throw new Error(`GET /zonas/ falhou (HTTP ${r.status})`);
    }

    const html = String(r.data);
    const zonas: PortalZone[] = [];
    const re = /<a\s+href="\/accreditation\/evento\/\d+\/zona\/(\d+)\/"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const id = Number(m[1]);
      const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      // O texto vem tipo "Zona Roxa Clique para credenciar à esta zona" — pega só o início
      const name = text.replace(/\s*clique.*$/i, "").trim();
      const slug = nameToSlug(name);
      zonas.push({ id, name, slug });
    }
    this.zonasCache.set(eventId, { at: Date.now(), zonas });
    return zonas;
  }

  /**
   * Resolve um zoneSlug (ex: "zona-roxa") para o id numérico do evento.
   * Aceita também o id numérico literal pra bypass.
   */
  async resolveZoneId(eventId: number, zoneSlug: string): Promise<number | null> {
    if (/^\d+$/.test(zoneSlug)) return Number(zoneSlug);
    const zonas = await this.listZonas(eventId);
    const target = nameToSlug(zoneSlug);
    return zonas.find((z) => z.slug === target)?.id ?? null;
  }

  /**
   * Só verifica o status da pessoa naquela zona (não solicita nada).
   *
   * Estados que detecta no HTML:
   *  - badge "Credenciado" (verde) → status: credenciado (aprovado pela FPF)
   *  - badge "Pré-Credenciado à esta zona" → status: pre_credenciado
   *  - form com action credenciar e classe sem 'remove_credential_form' →
   *    status: nao_solicitado (pessoa cadastrada na zona mas sem solicitação)
   *  - sem nenhum bloco de pessoa → pessoa_nao_encontrada
   */
  async checkCredencial(
    eventId: number,
    zoneId: number,
    cpf: string,
  ): Promise<CheckResult> {
    if (!this.loggedIn) await this.login();

    const cpfClean = cpf.trim();
    const zonePath = `/accreditation/evento/${eventId}/zona/${zoneId}/`;
    let page = await this.http.get(zonePath, { params: { cpf: cpfClean } });

    if (page.status === 302 || /input[^>]+name="username"/.test(String(page.data))) {
      this.loggedIn = false;
      await this.login();
      page = await this.http.get(zonePath, { params: { cpf: cpfClean } });
    }

    if (page.status !== 200) {
      return { status: "error", message: `GET zona falhou HTTP ${page.status}` };
    }

    const html = String(page.data ?? "");
    const personId = extractPersonId(html, eventId, zoneId) ?? undefined;

    // Procura o bloco da pessoa pra ler badge de status. O CPF buscado
    // aparece na seção dos resultados (não no input/breadcrumb).
    const cpfDigits = cpfClean.replace(/\D/g, "");
    const hasPerson =
      html.includes(cpfClean) ||
      (cpfDigits.length === 11 && html.replace(/\D/g, "").includes(cpfDigits));

    if (!hasPerson) {
      return {
        status: "pessoa_nao_encontrada",
        message: "CPF não aparece na lista de pessoas cadastradas pra essa zona",
      };
    }

    // Distingue credenciado (FPF aprovou) de pré-credenciado (só pedido)
    if (/Credenciad[ao] à esta zona/i.test(html) && !/Pré-?Credenciado/i.test(html)) {
      return { status: "credenciado", message: "Aprovado pela FPF", personId };
    }
    if (
      /Pré-?Credenciado à esta zona/i.test(html) ||
      /class="[^"]*remove_credential_form[^"]*"/i.test(html) ||
      /(Remover|Cancelar)\s+Solicita/i.test(html)
    ) {
      return { status: "pre_credenciado", message: "Solicitado, aguardando FPF aprovar", personId };
    }
    if (personId) {
      return {
        status: "nao_solicitado",
        message: "Cadastrada na zona, mas ainda sem solicitação de credenciamento",
        personId,
      };
    }
    return {
      status: "error",
      message: "HTML não casou com nenhum padrão conhecido — verificar manualmente",
    };
  }

  /**
   * Solicita pré-credencial pra uma pessoa numa zona+evento.
   * @param zoneId  ID numérico da zona (ex: 92155). NÃO é o slug.
   */
  async solicitarCredencial(
    eventId: number,
    zoneId: number,
    cpf: string,
  ): Promise<SolicitacaoResult> {
    if (!this.loggedIn) await this.login();

    // 1. GET página da zona com filtro de CPF, pra achar o personId no botão
    const cpfClean = cpf.trim();
    const zonePath = `/accreditation/evento/${eventId}/zona/${zoneId}/`;
    let page = await this.http.get(zonePath, {
      params: { cpf: cpfClean },
    });

    // Se sessão expirou, refaz login e tenta de novo
    if (page.status === 302 || page.status === 401 || /input[^>]+name="username"/.test(String(page.data))) {
      this.loggedIn = false;
      await this.login();
      page = await this.http.get(zonePath, { params: { cpf: cpfClean } });
    }

    if (page.status !== 200) {
      return { status: "error", message: `GET zona falhou HTTP ${page.status}` };
    }

    const html = String(page.data ?? "");
    const personId = extractPersonId(html, eventId, zoneId);
    const csrf = extractFormCsrf(html);

    // Idempotência: se a pessoa já está em qualquer estado de credenciamento
    // (pré-credenciada aguardando FPF, ou credenciada/aprovada pela FPF), não
    // tenta nada — re-submit retorna HTTP 500. Cobertura ampla pra não falhar.
    const alreadyState = detectAlreadyState(html);
    if (alreadyState) {
      return {
        status: "success",
        message: alreadyState,
        personId: personId ?? undefined,
      };
    }

    if (!personId) {
      return {
        status: "person_not_found",
        message: "Pessoa não apareceu na busca por CPF nessa zona (não cadastrada pela empresa pra essa zona)",
      };
    }
    if (!csrf) {
      return { status: "error", message: "CSRF token não encontrado na página da zona" };
    }

    // 2. POST credenciar
    const params = new URLSearchParams();
    params.set("csrfmiddlewaretoken", csrf);
    params.set("cpf", cpfClean);

    const submit = await this.http.post(
      `${zonePath}credenciar/${personId}/`,
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: `${PORTAL_BASE}${zonePath}?cpf=${encodeURIComponent(cpfClean)}`,
          Origin: PORTAL_BASE,
        },
        maxRedirects: 0, // queremos ver o 302
      },
    );

    if (submit.status === 302 || submit.status === 303) {
      const loc = String(submit.headers["location"] ?? "");
      // Após sucesso o portal redireciona pra mesma página de zona com mensagem de sucesso
      return { status: "success", personId, redirectLocation: loc };
    }
    if (submit.status === 200) {
      // Pode vir 200 com erro embutido no HTML
      const body = String(submit.data ?? "");
      if (/sem vaga|no available position|esgotada/i.test(body)) {
        return { status: "no_position", message: "Sem vaga liberada nessa zona/função", personId };
      }
      return { status: "error", message: `POST credenciar HTTP 200 sem redirect — ver HTML`, personId };
    }
    // 500 geralmente significa que a pessoa virou pré-credenciada entre o GET e o POST
    // (corrida de TOCTOU). Reverifica e, se já está, retorna sucesso silencioso.
    if (submit.status === 500) {
      const recheck = await this.http.get(zonePath, { params: { cpf: cpfClean } });
      if (recheck.status === 200) {
        const stillState = detectAlreadyState(String(recheck.data ?? ""));
        if (stillState) {
          return { status: "success", message: stillState, personId };
        }
      }
    }
    return {
      status: "error",
      message: `POST credenciar HTTP ${submit.status}`,
      personId,
    };
  }
}

// ── helpers de parsing ───────────────────────────────────────────────────────

/**
 * Extrai os eventos da página /accreditation/eventos/. Cada evento é um
 * <a href="/accreditation/evento/{id}/zonas/"> com <h5>Time A x Time B</h5>
 * e linhas "Data:", "Campeonato:" e "Local:" no corpo.
 */
function parseEventosPage(html: string): PortalEvent[] {
  const eventos: PortalEvent[] = [];
  const re = /<a\s+href="\/accreditation\/evento\/(\d+)\/zonas\/"[\s\S]*?<h5[^>]*>([^<]+)<\/h5>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const body = m[3];
    const grab = (label: string) =>
      body.match(new RegExp(`<strong>${label}:<\\/strong>\\s*([^<]+)`, "i"))?.[1]?.trim();
    eventos.push({
      id: Number(m[1]),
      name: m[2].trim(),
      date: grab("Data"),
      championship: grab("Campeonato"),
      venue: grab("Local"),
    });
  }
  return eventos;
}

/**
 * Detecta se o HTML da página de zona+CPF mostra a pessoa em algum estado
 * em que NÃO devemos solicitar de novo. Retorna mensagem amigável ou null.
 *
 * Cobre:
 *  - "Pré-Credenciado à esta zona" (badge azul, aguardando FPF)
 *  - "Credenciado à esta zona" / badge "Credenciado" sem "Pré-" (FPF aprovou)
 *  - form com classe remove_credential_form (estrutural — qualquer estado pós-pedido)
 *  - texto "Remover Solicitação" / "Cancelar Solicitação"
 */
function detectAlreadyState(html: string): string | null {
  if (/class="[^"]*remove_credential_form[^"]*"/i.test(html)) {
    return "Já estava solicitada/credenciada nessa zona — não foi feita nova solicitação";
  }
  if (/Pré-?Credenciado à esta zona/i.test(html)) {
    return "Já estava pré-credenciada (aguardando FPF aprovar)";
  }
  if (/Credenciad[ao] à esta zona/i.test(html)) {
    return "Já estava credenciada (aprovada pela FPF)";
  }
  // Badge verde "Credenciado" sem o "Pré-" prefix
  if (
    /class="[^"]*badge[^"]*(success|approved|credenciado)[^"]*"[^>]*>\s*Credenciado\s*</i.test(html) &&
    !/Pré-?Credenciado/i.test(html)
  ) {
    return "Já estava credenciada nessa zona";
  }
  if (/(Remover|Cancelar)\s+Solicita/i.test(html)) {
    return "Já tinha solicitação ativa nessa zona";
  }
  return null;
}

function extractFormCsrf(html: string): string | null {
  const m = html.match(
    /<input[^>]+name=["']csrfmiddlewaretoken["'][^>]+value=["']([^"']+)["']/i,
  ) ?? html.match(
    /<input[^>]+value=["']([^"']+)["'][^>]+name=["']csrfmiddlewaretoken["']/i,
  );
  return m?.[1] ?? null;
}

function extractPersonId(html: string, eventId: number, zoneId: number): number | null {
  const re = new RegExp(
    `action=["']/accreditation/evento/${eventId}/zona/${zoneId}/credenciar/(\\d+)/["']`,
    "i",
  );
  const m = html.match(re);
  return m ? Number(m[1]) : null;
}
