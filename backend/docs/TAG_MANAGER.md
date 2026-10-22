# Google Tag Manager dos clientes

O admin conecta o GTM de um cliente digitando só o código público do contêiner
(`GTM-XXXXXXX`) em **Clientes > (cliente) > Integrações > Google Tag Manager**.
Daí em diante o painel consegue:

- **Conferir**: versão no ar, tags, acionadores e variáveis, com um checklist em
  português (Pixel da Meta base, GA4, conversão do Google Ads com AW- + rótulo,
  Vinculador de conversões e tags duplicadas).
- **Criar tag** (formulário guiado): Pixel da Meta (base), GA4 (Google tag),
  Conversão do Google Ads (com acionador existente ou novo: página contém,
  envio de formulário ou clique) e Vinculador de conversões.
- **Publicar**: botão separado, com confirmação listando o que vai ao ar.

Tudo é exclusivo do admin. O login de cliente recebe 403 em `/api/gtm/*` e o
cartão não aparece no painel do cliente.

## Regras de segurança

- Criar tag mexe só no **rascunho** (espaço de trabalho "Instinto Digital",
  criado se não existir). Nada vai ao ar sem clicar em Publicar e confirmar.
- Publicar exige a lista de alterações que o admin viu. Se o rascunho mudou
  nesse meio tempo, o sistema recusa e mostra a lista nova.
- O sistema **nunca apaga** tag, acionador, variável ou versão. Não há
  operação destrutiva. "Desvincular" só apaga o vínculo no nosso banco.
- Tags repetidas são recusadas (ex.: um segundo Pixel com o mesmo ID).
- Toda ação (conectar, criar, publicar, desvincular, recusas e erros) fica
  registrada na tabela `gtm_log` com quem, quando, o quê e o resultado. O botão
  **Histórico** mostra esse registro.
- O token do Google **nunca** é salvo no banco nem aparece em log.

## O que o Jorge precisa fazer (uma vez)

### 1. Ativar a API

Google Cloud Console, no **mesmo projeto** do cliente OAuth do Google Ads:
**APIs e serviços > Biblioteca > "Tag Manager API" > Ativar**.

### 2. Conferir o tipo do cliente OAuth

**APIs e serviços > Credenciais**, abra o cliente OAuth do `GOOGLE_CLIENT_ID`.

- **Aplicativo da Web**: em "URIs de redirecionamento autorizados", adicione
  `https://api.instintodigital.com.br/api/gtm-oauth/callback` e salve.
- **App para computador (Desktop)**: esse tipo não aceita o nosso endereço de
  retorno. Crie um cliente novo, tipo **Aplicativo da Web**, com o URI acima, e
  coloque no hPanel `GOOGLE_GTM_CLIENT_ID` e `GOOGLE_GTM_CLIENT_SECRET`. O
  Google Ads continua usando o cliente antigo; o GTM passa a usar o novo. É a
  saída mais simples e segura: o token é gerado no nosso próprio servidor, sem
  copiar código de URL ou rodar script no computador.

### 3. Tela de consentimento

**APIs e serviços > Tela de consentimento OAuth**: o status deve ser
**Em produção**. Em "Teste" o Google invalida o token a cada 7 dias.

### 4. Gerar o token

1. Faça deploy desta versão.
2. Painel > qualquer cliente > Integrações > Google Tag Manager >
   **Autorizar Tag Manager** > **Continuar no Google**.
3. Entre com a conta Google **da agência** (a que tem ou vai ter acesso aos
   contêineres dos clientes) e aceite.
4. A página mostra o token **uma única vez**. Copie.
5. hPanel > Websites > api.instintodigital.com.br > Node.js > Variáveis de
   ambiente: crie `GOOGLE_GTM_REFRESH_TOKEN` com o token. Salve e reinicie.
6. Opcional: `GTM_AGENCY_EMAIL` com o e-mail dessa conta, para aparecer na
   ajuda que você manda ao cliente.

Se o Google não devolver token (já autorizado antes), remova o acesso do app
em https://myaccount.google.com/permissions e autorize de novo.

Escopos pedidos:

- `https://www.googleapis.com/auth/tagmanager.readonly`
- `https://www.googleapis.com/auth/tagmanager.edit.containers`
- `https://www.googleapis.com/auth/tagmanager.edit.containerversions`
- `https://www.googleapis.com/auth/tagmanager.publish`
- `https://www.googleapis.com/auth/adwords` (incluído para que o mesmo token
  sirva também ao Google Ads se for a mesma conta)

Sem `GOOGLE_GTM_REFRESH_TOKEN`, o sistema tenta o `GOOGLE_REFRESH_TOKEN`
(só funciona se ele tiver os escopos acima e se não houver
`GOOGLE_GTM_CLIENT_ID`). O botão "Conferir permissões" no cartão mostra quais
escopos o token atual tem.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `GOOGLE_GTM_REFRESH_TOKEN` | Token gerado no passo 4. |
| `GOOGLE_GTM_CLIENT_ID` / `GOOGLE_GTM_CLIENT_SECRET` | Só se o cliente OAuth atual for Desktop. |
| `GTM_OAUTH_REDIRECT_URI` | Opcional. Padrão `https://api.instintodigital.com.br/api/gtm-oauth/callback`. |
| `GTM_AGENCY_EMAIL` | Opcional. E-mail mostrado na ajuda. |

## O que o cliente precisa fazer

No Tag Manager dele: **Administrador > Gerenciamento de usuários do contêiner
> Adicionar usuário**, com o e-mail Google da agência e a permissão
**Publicar** (sem ela dá para conferir e criar no rascunho, mas não publicar).
Depois ele manda o código `GTM-XXXXXXX`.

Se o contêiner não aparecer, a mensagem de erro já explica isso ao admin.

## Endpoints (todos admin, `Authorization: Bearer`)

| Método | Caminho | O quê |
|---|---|---|
| GET | `/api/gtm/status` (`?check=1` confere escopos) | Configuração e modo (teste/real) |
| POST | `/api/gtm/oauth/start` | Gera o link de autorização (state assinado, 10 min, uso único) |
| GET | `/api/gtm-oauth/callback` | Retorno do Google; mostra o token uma vez |
| GET | `/api/gtm/:clientId` | Vínculo atual |
| POST | `/api/gtm/:clientId/connect` `{publicId}` | Acha o contêiner (accounts.list + containers.list) e salva accountId, containerId e publicId |
| POST | `/api/gtm/:clientId/disconnect` | Remove só o vínculo local |
| GET | `/api/gtm/:clientId/audit` | Versão no ar, rascunho, listas e checklist |
| POST | `/api/gtm/:clientId/tags` | Cria tag no rascunho (`kind`: `meta_pixel`, `ga4`, `ads_conversion`, `conversion_linker`) |
| GET | `/api/gtm/:clientId/pending` | Alterações do rascunho |
| POST | `/api/gtm/:clientId/publish` `{confirm:true, expected:[...]}` | Cria versão e publica |
| GET | `/api/gtm/:clientId/log` | Histórico |

Erros comuns: 401 do Google vira "autorize de novo"; falta de escopo ou API
desativada viram 409 com explicação; 429 é tentado de novo uma vez.

## Detalhes do Tag Manager

- Contêiner gratuito aceita até 3 espaços de trabalho. Se já houver 3, o
  sistema avisa para publicar ou fechar um deles.
- Ao publicar, o Tag Manager cria a versão e **fecha** o espaço "Instinto
  Digital". Na próxima tag criada, o sistema abre um novo.
- Antes de publicar o sistema sincroniza o rascunho com a versão no ar. Se
  houver conflito, a publicação é bloqueada e deve ser resolvida no GTM.
- Se a conta tiver permissão de editar mas não de publicar, a versão é criada
  e o painel avisa "versão X criada mas sem permissão Publicar".
- Para desfazer uma publicação: no GTM, Versões > versão anterior > Publicar.

## Modo de teste

Com `USE_MOCK_DATA=true` nada chama o Google. Contêineres simulados:

- `GTM-TESTE01`: publicado, com Pixel, GA4 duplicado, conversão do Ads,
  uma tag pausada e uma de Universal Analytics.
- `GTM-TESTE02`: nunca publicado, vazio.
- `GTM-SEMPUB1`: publicar falha por falta de permissão.

"Autorizar Tag Manager" abre uma página de simulação com token falso.
