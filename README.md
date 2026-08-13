# Credenciamento Contra Ataque × Ligatech

Automação de credenciamento de equipe em jogos via portal da Ligatech
(staff.ligatech.com.br). Sobe a planilha da transmissão (.xlsx), o app
identifica o jogo e solicita o credenciamento de todo mundo de uma vez,
com barra de progresso e relatório final exportável.

## Como funciona

1. Arraste a planilha da transmissão na página inicial
2. O app lê o topo da planilha ("Transmissão:", "Data da Transmissão:") e
   localiza o evento correspondente no portal da Ligatech
3. Clique em **Solicitar credenciamento** — cada pessoa da lista é
   credenciada na zona indicada na planilha
4. Ou use **Verificar status (sem solicitar)** pra só consultar quem já está
   credenciado

Linhas sem CPF válido (títulos de seção, tabela de carros) são ignoradas.
Quem já está credenciado não é solicitado de novo (idempotente).

## Formato esperado da planilha

- Topo com linhas rotuladas: `Transmissão: <campeonato> - <Time A x Time B>`,
  `Data da Transmissão: DD_MM_AAAA`, `Local: ...`, `Horário: ...`
- Tabela com cabeçalho contendo as colunas **NOME** e **CPF** (RG e FUNÇÃO
  opcionais); a coluna logo após o CPF indica a zona (ex: `zona roxa`)

## Variáveis de ambiente

| Variável | O que é |
|---|---|
| `LIGATECH_PORTAL_USERNAME` | e-mail de login no portal staff.ligatech.com.br |
| `LIGATECH_PORTAL_PASSWORD` | senha do portal |
| `SELF_URL` | (opcional) URL pública do app — ativa o keep-alive que evita o servidor dormir |

## Rodando localmente

```bash
npm install
npm run build
LIGATECH_PORTAL_USERNAME=... LIGATECH_PORTAL_PASSWORD=... npm start
# abre http://localhost:3333
```

## Deploy no Render (grátis)

1. Crie uma conta em https://render.com
2. **New → Web Service** e conecte este repositório
3. Configure:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Em **Environment**, adicione `LIGATECH_PORTAL_USERNAME` e
   `LIGATECH_PORTAL_PASSWORD`
5. Deploy. A URL pública aparece no topo do painel.

No plano free o servidor hiberna após 15 min sem uso — o primeiro acesso do
dia demora ~1 minuto pra acordar. É normal.
