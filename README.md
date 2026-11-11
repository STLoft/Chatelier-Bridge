# Chatelier-Bridge

[Chatelier](https://github.com/STLoft/Chatelier)의 SillyTavern 서버 플러그인입니다. 서버에 설치된 **Codex CLI**를 실행하고 생성 이미지를 보관합니다.

**PC와 터먹스에서 같은 저장소를 설치합니다.** 브라우저용 확장과 서버 플러그인을 각각 설치하며, 별도의 로컬 HTTP 브리지를 켤 필요는 없습니다. SillyTavern 서버를 시작하면 플러그인이 함께 로드됩니다.

## 실행 구조

```text
Chatelier 화면
    ↓ SillyTavern 내부 API
Chatelier-Bridge
    ↓ 서버 환경에 설치된 Codex CLI
    ├─ PC: codex app-server
    └─ 터먹스: codex exec -
```

계정 로그인은 Codex CLI가 관리합니다. 이 플러그인은 인증 토큰 파일을 직접 읽거나 복사하지 않습니다. 별도 OpenAI API 키를 입력하는 방식도 아닙니다.

## 준비 사항

- 실행 중인 SillyTavern 설치 환경
- 그 서버 환경에서 사용할 수 있는 Git과 Node.js 20 이상
- Codex CLI 엔진을 사용할 경우 같은 환경에 설치·로그인된 Codex CLI
- 브라우저에 설치할 [Chatelier 확장](https://github.com/STLoft/Chatelier)

브라우저가 실행되는 기기와 SillyTavern 서버가 실행되는 기기를 구분하세요. 휴대폰으로 PC 서버에 접속하는 경우 플러그인과 CLI는 PC에 설치합니다.

## 설치

### 1. SillyTavern 서버 종료 및 폴더 열기

서버를 실행한 터미널에서 `Ctrl+C`로 종료합니다. 새 터미널을 열고 **`config.yaml`, `package.json`, `server.js`가 있는 SillyTavern 폴더**로 이동합니다.

아래 설치 명령은 이 폴더에서 실행해야 합니다. 브라우저 확장 폴더나 `plugins` 폴더 안에서 실행하는 명령이 아닙니다.

### 2. 서버 플러그인 설치

```sh
git clone https://github.com/STLoft/Chatelier-Bridge.git plugins/Chatelier-Bridge
```

설치 후 구조:

```text
SillyTavern/
├─ config.yaml
├─ server.js
└─ plugins/
   └─ Chatelier-Bridge/
      ├─ package.json
      ├─ index.js
      └─ exec-transport.cjs
```

플러그인은 Node.js 기본 모듈만 사용하므로 플러그인 폴더에서 별도의 `npm install`을 실행할 필요가 없습니다.

이미 `plugins/Chatelier-Bridge`가 있으면 다시 clone하지 말고 [업데이트](#업데이트) 절차를 사용하세요. 동일한 플러그인을 다른 폴더명으로 설치해 두었다면 두 사본을 동시에 활성화하지 마세요. 이전 사본은 서버를 종료한 상태에서 `plugins` 밖으로 백업하세요.

### 3. 서버 플러그인 활성화

SillyTavern의 `config.yaml`에서 다음 값을 확인합니다.

```yaml
enableServerPlugins: true
```

자동 업데이트도 사용하려면 다음 값을 설정합니다.

```yaml
enableServerPluginsAutoUpdate: true
```

같은 키를 파일 끝에 중복해서 추가하지 말고 기존 값을 수정하세요. `true`는 따옴표 없이 입력합니다.

### 4. Codex CLI 준비

#### PC: Windows / macOS / Linux

Codex CLI가 이미 동작하면 재설치할 필요가 없습니다. 아직 설치하지 않았다면 [OpenAI Docs의 설치 안내](https://learn.chatgpt.com/docs/codex/cli)를 따르세요. npm 설치 예시는 다음과 같습니다.

```sh
npm install -g @openai/codex
codex --version
codex login
codex login status
```

로그인에서는 **ChatGPT 계정으로 로그인**을 선택합니다. 설치 후 새 터미널을 열어야 경로가 반영될 수 있습니다. SillyTavern을 실행할 사용자 계정에서 로그인하세요.

#### Android 터먹스

[터먹스 전용 안내](docs/TERMUX.md)를 따라 진행합니다. 네이티브 터먹스에서 실행하는 절차이며, PC와 동일한 플러그인을 설치합니다.

### 5. 서버 시작 및 화면 확인

1. 평소 사용하던 방법으로 SillyTavern 서버를 다시 시작합니다.
2. 브라우저에서 [Chatelier 확장](https://github.com/STLoft/Chatelier#빠른-설치)을 설치합니다.
3. **Chatelier → 설정 → 이미지 엔진 → Codex CLI**를 선택합니다.
4. 상태 새로고침으로 CLI와 로그인 상태를 확인합니다.
5. PC에서는 모델 목록에서 모델을 선택합니다. 터먹스에서는 모델 ID를 비워 두거나 직접 입력합니다.
6. **설정 저장** 후 이미지를 생성합니다.

기본 API 경로는 `/api/plugins/codex-image`입니다. 브라우저가 SillyTavern 서버를 통해 접근하므로 주소나 포트를 별도로 입력하지 않습니다.

## PC와 터먹스의 차이

| 항목 | PC | 네이티브 터먹스 |
| --- | --- | --- |
| 서버 플러그인 | 같은 저장소 | 같은 저장소 |
| 기본 CLI 실행 | `codex app-server` | `codex exec -` |
| 프롬프트 전달 | app-server RPC | 표준입력 |
| 모델 선택 | CLI에서 받은 목록 | CLI 기본값 또는 직접 입력 |
| 생성 결과 | 이미지 생성 이벤트 | 새로 생성된 로컬 이미지 파일 |
| 추가 서버 실행 | 불필요 | 불필요 |

터먹스 감지는 Node.js 플랫폼, `TERMUX_VERSION`, `PREFIX`를 사용합니다. 필요할 때 서버 환경변수 `ST_CODEX_TRANSPORT=exec`로 직접 지정할 수 있습니다.

터먹스 Codex CLI 패키지는 커뮤니티 빌드입니다. 해당 빌드와 계정에 이미지 생성 기능이 제공되어야 합니다. 플러그인이 모델 또는 도구 사용 권한을 추가해 주지는 않습니다. Android 실기기별 작동은 CLI 빌드와 환경에 따라 확인이 필요합니다.

## 환경변수

| 변수 | 용도 | 기본값 |
| --- | --- | --- |
| `ST_CODEX_BIN` | CLI 실행 파일 경로 지정 | PATH에서 `codex` 검색 |
| `ST_CODEX_TRANSPORT` | `app-server` 또는 `exec` | 터먹스 `exec`, 그 외 `app-server` |
| `CODEX_HOME` | CLI 자체 설정·로그인 환경 선택 | Codex CLI 기본 동작 |
| `ST_CODEX_SANDBOX` | app-server의 샌드박스 이름을 명시적으로 지정 | `workspace-write`부터 시도 |
| `ST_CODEX_ALLOW_CLI_UPDATE` | PC 화면에서 CLI 업데이트 허용 | 꺼짐. `1`이면 허용 |

환경변수는 **SillyTavern 서버를 시작하는 터미널·서비스**에 설정해야 합니다. 브라우저 새로고침만으로는 변경되지 않습니다. 일반적인 설치에서는 설정할 필요가 없습니다.

경로를 지정하는 예시:

```powershell
# Windows PowerShell. 실제 설치 경로로 바꿉니다.
$env:ST_CODEX_BIN = (Get-Command codex.cmd).Source
node server.js
```

```sh
# macOS / Linux / 터먹스. SillyTavern 폴더에서 실행합니다.
export ST_CODEX_BIN="$(command -v codex)"
node server.js
```

터먹스에서는 PC용 `@openai/codex`로 자동 교체하지 않도록 화면의 CLI 업데이트를 제공하지 않습니다. 서버 터미널에서 설치한 터먹스용 패키지를 업데이트하세요.

## 저장 위치와 처리 범위

| 위치 | 내용 |
| --- | --- |
| `plugins/Chatelier-Bridge/output/` | 생성 및 보관된 이미지 |
| `plugins/Chatelier-Bridge/workspace/jobs/` | 생성 중 임시 참조 이미지와 작업 파일 |
| SillyTavern 사용자 설정 | Chatelier 프리셋, 확장 설정, 기록 |

정상적인 요청 종료·취소 후 해당 임시 작업 폴더를 정리합니다. 서버나 Android 프로세스가 강제로 종료되면 임시 폴더가 남을 수 있습니다. 생성 이미지는 기록 사용을 위해 보관하며 Git 추적에서 제외합니다.

한 서버 프로세스는 그 프로세스의 Codex CLI 로그인을 사용합니다. 여러 사용자가 접속하는 서버에서도 사용자마다 Codex CLI 계정이 분리되는 구조는 아닙니다. 이미지 보관 폴더와 파일 비우기 기능도 서버 단위입니다.

## 업데이트

SillyTavern 서버를 종료하고 **SillyTavern 폴더**에서 실행합니다.

```sh
git -C plugins/Chatelier-Bridge pull --ff-only
```

그다음 서버를 다시 시작하고, 브라우저의 확장 관리에서 Chatelier도 업데이트한 뒤 새로고침합니다. 서버 플러그인 업데이트에는 서버 재시작이 필요합니다.

Codex CLI는 별도로 업데이트합니다.

```sh
# PC에서 npm으로 설치한 경우
npm install -g @openai/codex
```

터먹스용 CLI는 [터먹스 안내의 업데이트](docs/TERMUX.md#업데이트)를 참고하세요. 플러그인 업데이트는 CLI나 프리셋을 덮어쓰지 않습니다. 로컬에서 소스를 직접 수정했다면 `git pull`이 중단될 수 있으므로 수정분을 따로 보관하세요.

## 문제 해결

### 404 또는 서버 플러그인이 없다고 표시됨

- 서버의 `plugins/Chatelier-Bridge/index.js`가 존재하는지 확인합니다.
- `config.yaml`의 `enableServerPlugins` 값이 `true`인지 확인합니다.
- 서버 터미널의 플러그인 초기화 오류를 확인합니다.
- 서버를 완전히 종료하고 다시 시작합니다.
- 다른 기기의 SillyTavern 서버를 보고 있다면 그 서버에 설치해야 합니다.

### 터미널에서는 codex가 되는데 화면에는 CLI가 없다고 표시됨

SillyTavern을 실행하는 터미널에서 아래를 확인합니다.

```sh
codex --version
codex login status
```

서버를 실행한 사용자, PATH, `CODEX_HOME`이 로그인한 환경과 같은지 확인합니다. 서비스 실행 환경이나 별도 터미널에서는 PATH가 다를 수 있으므로 `ST_CODEX_BIN`으로 실행 파일을 지정하고 재시작하세요.

### 로그인은 되어 있는데 이미지 생성이 되지 않음

이 플러그인은 ChatGPT 로그인을 사용합니다. API 키 방식으로 로그인된 경우 ChatGPT 로그인을 다시 확인하세요. 모델 목록은 사용 가능성을 안내하는 목록이며 이미지 생성 권한을 보증하지 않습니다. 이미지 생성 도구 미제공, 계정 제한, CLI 버전 차이 등은 생성 요청의 오류 메시지로 확인합니다.

### 터먹스에서 모델 목록이 비어 있음

exec 방식에서는 모델 목록을 조회하지 않습니다. 모델 ID 입력란을 비워 두면 CLI 기본 모델을 사용합니다. 모델 ID를 직접 지정했다면 해당 CLI·계정에서 사용할 수 있는 ID인지 확인하세요.

### exec가 성공했는데 새 이미지가 없다고 표시됨

exec 방식은 요청 작업 폴더와 CLI의 `generated_images` 폴더를 생성 전후로 비교합니다. 참조 이미지나 기존 이미지는 결과로 반환하지 않습니다. 도구가 파일을 저장하지 않았거나 텍스트로만 답한 경우 오류로 처리합니다. 이 방식으로 생성하는 동안 같은 CLI 환경에서 다른 이미지 생성 작업을 병행하지 않는 것이 좋습니다.

### 이미지 생성 취소 또는 시간 초과

app-server는 최대 7분, exec는 최대 8분을 기다립니다. 취소 시 CLI 프로세스를 종료합니다. Android에서는 백그라운드 제한·배터리 최적화도 확인하세요.

## 개발 확인

의존성 설치 없이 플러그인 폴더에서 실행합니다.

```sh
npm test
npm run check
```

테스트는 모의 CLI를 사용하며 실제 계정 로그인이나 이미지 생성 요청을 실행하지 않습니다.

## 참고 문서

- [SillyTavern 서버 플러그인](https://docs.sillytavern.app/for-contributors/server-plugins/)
- [OpenAI Docs: Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [OpenAI Docs: 인증](https://learn.chatgpt.com/docs/auth)
- [OpenAI Docs: app-server](https://learn.chatgpt.com/docs/app-server)

STLoft의 커뮤니티 프로젝트이며, SillyTavern 또는 OpenAI의 공식 플러그인이 아닙니다.
