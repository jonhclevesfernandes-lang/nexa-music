# Nexa Music V2

Nexa Music V2 é uma PWA de streaming musical com identidade própria, inspirada na experiência de players modernos, com frontend responsivo, backend Node.js/Express, autenticação e persistência em PostgreSQL.

## Recursos implementados

### Reprodução
- Player persistente
- Play / pause / próxima / anterior
- Barra de progresso e volume
- Aleatório e repetição
- Fila de reprodução
- Media Session API quando suportada pelo dispositivo

### Catálogo e biblioteca
- Busca por música, artista, álbum e estilo
- Favoritos
- Histórico recente
- Playlists: criar, editar, excluir, adicionar e remover faixas
- Importação local de áudio pelo usuário via IndexedDB
- PWA instalável

### Conta online
- Cadastro
- Login com JWT
- Senhas com hash bcrypt
- Perfil sincronizado
- Favoritos sincronizados
- Playlists sincronizadas
- Histórico sincronizado

### Administração
- Conta administrativa opcional por variáveis de ambiente
- Publicação de faixa com áudio e capa
- Catálogo publicado fica disponível a todos os usuários
- Endpoint de estatísticas administrativas

### Infraestrutura
- PostgreSQL
- Migração/esquema automático na inicialização
- Seed automático das 6 faixas originais de demonstração
- Áudio demonstrativo sintetizado pelo servidor, sem arquivos MP3 no repositório
- Dockerfile
- docker-compose para desenvolvimento local
- railway.json com health check
- Endpoint `/api/health`

## Estrutura

```text
nexa-music-v2/
├── server.js
├── package.json
├── Dockerfile
├── docker-compose.yml
├── railway.json
├── .env.example
└── public/
    ├── index.html
    ├── app.js
    ├── styles.css
    ├── sw.js
    ├── manifest.webmanifest
    └── assets/
```

## Rodar localmente

A forma mais simples é usar Docker:

```bash
docker compose up --build
```

Depois abra:

```text
http://localhost:3000
```

Sem Docker, crie um PostgreSQL, copie `.env.example` para `.env`, configure `DATABASE_URL` e execute:

```bash
npm install
npm start
```

## Variáveis de ambiente

Obrigatórias em produção:

- `DATABASE_URL`: conexão PostgreSQL
- `JWT_SECRET`: chave secreta longa e aleatória

Opcionais:

- `PORT`: padrão 3000
- `ADMIN_EMAIL`: e-mail da conta administrativa
- `ADMIN_PASSWORD`: senha inicial do administrador, mínimo 8 caracteres
- `ADMIN_NAME`: nome do administrador
- `NODE_ENV`: `production` no deploy

## Railway

O projeto foi preparado para Railway. Fluxo recomendado:

1. Criar um repositório GitHub vazio, por exemplo `nexa-music`.
2. Enviar o conteúdo desta pasta para a branch `main`.
3. Conectar esse repositório ao projeto Railway `nexa-music`.
4. Adicionar PostgreSQL ao projeto.
5. Definir `DATABASE_URL`, `JWT_SECRET` e, se desejado, as variáveis de administrador.
6. Fazer o deploy.
7. Gerar o domínio público `*.up.railway.app`.
8. Validar `/api/health`, cadastro, login, player e persistência.

## Catálogo musical e direitos

As seis faixas de demonstração incluídas na aplicação foram criadas exclusivamente para este projeto. Em produção, publique apenas conteúdo próprio, licenciado ou cuja distribuição esteja autorizada.

## Evolução para escala comercial

A V2 guarda uploads administrativos no PostgreSQL para manter a implantação autocontida e funcional. Para um catálogo grande, a evolução indicada é mover áudio e capas para object storage/CDN (S3, R2 ou equivalente), usando URLs assinadas e mantendo somente metadados no PostgreSQL.
