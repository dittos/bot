# Slack + Discord + IRC + Codex Auth 챗봇

한 프로세스에서 여러 Slack/Discord/IRC 봇을 동시에 실행합니다.

- Slack: 멘션/스레드/DM 대응
- Discord: 멘션/DM 대응
- IRC: 채널 멘션/DM 대응
- AI 호출 인증은 `CODEX_REFRESH_TOKEN` 기반이며, 필요하면 회전된 토큰을 파일로 영속화할 수 있습니다.

## 1) 로컬 CLI로 먼저 테스트

```bash
npm install
export CODEX_REFRESH_TOKEN=your_codex_refresh_token
npm run chat
```

CLI 명령:

- `/reset`: 문맥 초기화
- `/exit`: 종료

인증 환경변수:

- `CODEX_REFRESH_TOKEN`: access token 자동 갱신에 사용 (required)
- `CODEX_REFRESH_TOKEN_FILE`: refresh token rotation 결과를 저장할 파일 경로 (optional, 재시작 환경 권장)
- account id 헤더는 refresh 응답의 토큰 클레임에서 자동 추출

Kubernetes처럼 재시작이 발생하는 환경에서는 refresh token이 1회 사용 후 회전되므로,
기본 Helm 차트는 `/app/data/codex-refresh-token` 경로를 PVC에 저장하도록 구성되어 있습니다.
직접 실행할 때도 `CODEX_REFRESH_TOKEN_FILE`을 writable persistent volume 경로로 맞추면 이전 토큰 재사용 오류를 피할 수 있습니다.

## 2) 서비스 설정 파일

기본 경로: `config/services.json`

```json
{
  "slack": [
    {
      "name": "main",
      "botToken": "xoxb-your-bot-token",
      "appToken": "xapp-your-app-level-token",
      "model": "gpt-5.3-codex",
      "systemPrompt": "You are a helpful Slack assistant.",
      "webSearch": false
    }
  ],
  "discord": [
    {
      "name": "main",
      "botToken": "your-discord-bot-token",
      "model": "gpt-5.3-codex",
      "systemPrompt": "You are a helpful Discord assistant.",
      "webSearch": false
    }
  ],
  "irc": [
    {
      "name": "libera",
      "server": "irc.libera.chat",
      "port": 6697,
      "ssl": true,
      "nick": "codexbot",
      "username": "codexbot",
      "realname": "Codex Bot",
      "channels": ["#your-channel"],
      "sasl": {
        "enabled": true,
        "mechanism": "PLAIN",
        "username": "codexbot",
        "password": "your-sasl-password"
      },
      "model": "gpt-5.3-codex",
      "systemPrompt": "You are a helpful IRC assistant.",
      "webSearch": false
    }
  ]
}
```

`config/services.example.json` 예시 파일도 함께 제공합니다.
각 서비스 항목의 `model`은 필수이며, IRC는 `server`, `nick`, `channels`도 필수입니다.
서비스별 `systemPrompt`를 넣으면 해당 서비스에만 적용됩니다.

## 3) Slack App 준비

- OAuth Scopes (Bot Token Scopes)
  - `app_mentions:read`
  - `chat:write`
  - `reactions:write`
  - `channels:history`
  - `im:history`
- Event Subscriptions
  - `app_mention`
  - `message.channels`
  - `message.im`
- Socket Mode
  - App-Level Token 발급 (`connections:write`)

## 4) Discord Bot 준비

- Bot 계정 생성 후 토큰 발급
- Privileged Gateway Intents:
  - `MESSAGE CONTENT` 활성화
- OAuth2에서 봇을 서버에 초대

## 5) IRC 준비

- IRC 서버 주소/포트와 봇 계정(nick) 준비
- SSL/TLS 서버면 `ssl: true`와 `port: 6697` 사용 (`tls` 키도 호환)
- SASL 사용 시 `sasl.enabled: true`, `sasl.mechanism: PLAIN`, `sasl.username/password` 설정
- 응답할 채널 목록을 `channels`에 설정

## 6) 실행

```bash
export CODEX_REFRESH_TOKEN=your_codex_refresh_token
npm run start
```

## 7) Docker 빌드/실행

```bash
docker build -t slack-openai-bot .
docker run --rm \
  -e CODEX_REFRESH_TOKEN=your_codex_refresh_token \
  -v "$(pwd)/config/services.json:/app/config/services.json:ro" \
  slack-openai-bot
```

## 8) Helm 배포

차트 경로: `helm/slack-openai-bot`

```bash
helm upgrade --install bot ./helm/slack-openai-bot \
  --set image.repository=your-repo/slack-openai-bot \
  --set image.tag=latest \
  --set auth.refreshToken=your_codex_refresh_token
```

민감정보 관리를 위해 `auth.existingSecret`, `config.servicesExistingSecret` 사용을 권장합니다.

## 파일 구조

- `src/index.js`: 멀티 서비스 런처
- `src/connectors/slack.js`: Slack 연결
- `src/connectors/discord.js`: Discord 연결
- `src/connectors/irc.js`: IRC 연결
- `src/ai.js`: Codex auth 기반 AI 호출
- `src/cli.js`: 로컬 테스트 CLI
- `Dockerfile`: 컨테이너 이미지 빌드
- `helm/slack-openai-bot`: Kubernetes Helm 차트
- `config/services.json`: 서비스 구성
- `config/services.example.json`: 서비스 구성 예시
