# Planilha de respostas dos formulários

Cada formulário ganha uma planilha na conta Google da agência. Cada envio
vira uma linha (data/hora de Brasília, perguntas, qualificado ou
desqualificado, UTMs e página de origem). O Jorge copia o link e manda
para o cliente enquanto o CRM do cliente não está no ar.

A gravação acontece depois que o lead já foi salvo. Se o Google falhar,
o envio do formulário continua valendo. O sistema tenta de novo e deixa
o erro registrado na aba Compartilhar do formulário. "Sincronizar
respostas antigas" manda o que ficou para trás.

Pergunta nova vira coluna nova no fim da planilha. Pergunta renomeada só
atualiza o título da coluna. Pergunta apagada continua na planilha, para
as respostas antigas não mudarem de lugar.

## Por que não é uma service account

A planilha precisa ser da conta da agência (`jorgelcogo@gmail.com`), para
abrir no Drive dessa conta e compartilhar com o cliente. Arquivo criado
por service account fica no nome da service account. O Google não
transfere a propriedade disso para um Gmail comum (só transfere dentro
de um Google Workspace) e a delegação de domínio também exige Workspace.

O caminho é o mesmo OAuth que o Tag Manager já usa (cliente "Dash
Instinto", projeto `instinto-dash`), com um **token novo e separado**:

- `GOOGLE_SHEETS_REFRESH_TOKEN` — só Planilhas e os arquivos que o
  sistema criar.
- `GOOGLE_GTM_REFRESH_TOKEN` — continua sendo o do Tag Manager. Não
  substitua um pelo outro.
- `GOOGLE_REFRESH_TOKEN` — continua sendo o do Google Ads.

Reautorizar o Sheets não invalida os outros: cada um é um token
diferente, e a conta aguenta dezenas deles no mesmo cliente OAuth.

Escopos pedidos:

- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/drive.file` (criar a planilha e
  compartilhar só os arquivos que o próprio sistema criou, sem acesso
  ao resto do Drive)

## O que configurar uma vez

### 1. Ativar as APIs

Google Cloud Console, projeto **instinto-dash**:

**APIs e serviços > Biblioteca**, ative:

- **Google Sheets API**
- **Google Drive API**

### 2. URI de redirecionamento

**APIs e serviços > Credenciais**, abra o cliente OAuth do tipo
**Aplicativo da Web** usado pelo Tag Manager ("Dash Instinto", o mesmo
de `GOOGLE_GTM_CLIENT_ID` se essa variável existir; senão o de
`GOOGLE_CLIENT_ID`, se ele já for Aplicativo da Web).

Em **URIs de redirecionamento autorizados**, adicione:

`https://api.instintodigital.com.br/api/sheets-oauth/callback`

Salve. Não apague o URI do Tag Manager
(`/api/gtm-oauth/callback`).

Se o `GOOGLE_CLIENT_ID` for do tipo "App para computador" e não houver
`GOOGLE_GTM_CLIENT_ID`, use o cliente Web que o Tag Manager já pediu
para criar. Não crie um terceiro cliente, a menos que queira: aí sim
preencha `GOOGLE_SHEETS_CLIENT_ID` e `GOOGLE_SHEETS_CLIENT_SECRET`.

### 3. Tela de consentimento

**APIs e serviços > Tela de consentimento OAuth**: status **Em
produção**. Em "Teste" o Google invalida o token a cada 7 dias. Os
escopos acima entram na lista quando você autoriza; não precisa
publicar um app verificado para uma conta interna da agência, desde
que a tela já esteja em produção como no Tag Manager.

### 4. Gerar o token

1. Faça o deploy desta versão.
2. Painel > qualquer cliente > **Integrações** > cartão **Google Sheets
   (formulários)** > **Conectar Google Sheets**. O mesmo botão aparece
   na aba **Compartilhar** do formulário, se ainda não estiver conectado.
3. Entre com **jorgelcogo@gmail.com** e aceite Planilhas e Drive.
4. A página mostra o token **uma única vez**. Copie.
5. hPanel > Websites > api.instintodigital.com.br > Node.js > Variáveis
   de ambiente: crie `GOOGLE_SHEETS_REFRESH_TOKEN` com o token.
6. Salve e **reinicie** o app Node.js.
7. O cartão em Integrações deve mostrar **Conectado**.

Se o Google não devolver token (a conta já tinha autorizado o app),
remova o acesso em https://myaccount.google.com/permissions e autorize
de novo. Isso não apaga o token do Tag Manager que já está no hPanel,
mas o Google pode pedir para autorizar de novo se você revogar o app
inteiro: nesse caso gere os dois tokens outra vez, cada um no seu botão.

### 5. Variáveis

| Variável | Para quê |
|---|---|
| `GOOGLE_SHEETS_REFRESH_TOKEN` | Token do passo 4. Obrigatório. |
| `GOOGLE_SHEETS_CLIENT_ID` / `GOOGLE_SHEETS_CLIENT_SECRET` | Só se for usar outro cliente OAuth. Vazio = o cliente Web do Tag Manager, ou o `GOOGLE_CLIENT_ID`. |
| `SHEETS_OAUTH_REDIRECT_URI` | Opcional. Padrão `https://api.instintodigital.com.br/api/sheets-oauth/callback`. |
| `SHEETS_AGENCY_EMAIL` | Opcional. E-mail mostrado na tela. Se vazio, usa `GTM_AGENCY_EMAIL`. |

Com `USE_MOCK_DATA=true` nada é criado no Google (a planilha é simulada).

## No dia a dia

- Formulário novo: a planilha é criada na hora, se o token já estiver
  configurado.
- Formulário antigo: aba **Compartilhar** > **Criar planilha**.
- **Abrir planilha** e **Copiar link** mandam o endereço ao cliente.
- O interruptor pausa só as linhas novas. As respostas continuam no sistema.
- **Compartilhar** manda um convite do Google (pode ver, ou pode editar).
  O e-mail precisa ser uma conta Google.
- **Sincronizar respostas antigas** completa a planilha com o que já
  estava salvo aqui.
