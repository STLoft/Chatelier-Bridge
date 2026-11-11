# 터먹스에서 Chatelier-Bridge 사용하기

이 안내는 **Android의 네이티브 터먹스에서 SillyTavern 서버를 실행하는 경우**를 기준으로 합니다. PC와 동일한 [Chatelier-Bridge 저장소](https://github.com/STLoft/Chatelier-Bridge)를 설치합니다.

이미 SillyTavern과 Codex CLI가 동작한다면 재설치하지 말고 [2. 서버 플러그인 설치](#2-서버-플러그인-설치)부터 진행하세요.

## 1. 터먹스와 Codex CLI 확인

휴대폰에서 터먹스를 열고 실행합니다.

```sh
node --version
git --version
codex --version
codex login status
```

- Node.js는 20 이상이 필요합니다.
- `codex --version`에 버전이 나오고 `codex login status`에 ChatGPT 로그인이 확인되면 기존 CLI를 그대로 사용합니다.
- API 키 로그인만 되어 있다면 ChatGPT 계정으로 로그인해야 합니다.
- `codex` 명령이 없을 때만 아래 설치 절차를 진행합니다.

### 아직 Codex CLI가 없는 경우

터먹스 기본 패키지를 준비합니다.

```sh
pkg update
pkg install git nodejs-lts nano
uname -m
```

아래는 Android ARM64(`aarch64` 또는 `arm64`)에서 사용하는 **커뮤니티 터먹스 빌드**의 설치 예시입니다. OpenAI의 공식 npm 패키지와는 다른 배포입니다. 현재 사용 중인 터먹스용 CLI가 있다면 그것을 유지하세요.

```sh
npm install -g @mmmbuto/codex-cli-termux@latest
codex --version
```

다른 CPU 구조이거나 설치 후 CLI가 실행되지 않는다면 플러그인 설치보다 CLI 실행 문제를 먼저 해결해야 합니다. 이 저장소는 터먹스용 Codex CLI 바이너리를 포함하거나 자동 설치하지 않습니다.

### ChatGPT 로그인

SillyTavern을 실행하는 **같은 터먹스 환경**에서 실행합니다.

```sh
codex login
```

터미널에 표시되는 URL을 휴대폰 브라우저에서 열고 ChatGPT 계정으로 로그인한 뒤 터먹스로 돌아옵니다. 계정·CLI 환경에 따라 브라우저 로그인 화면이 다를 수 있습니다.

브라우저 콜백으로 로그인이 되지 않고 해당 빌드에서 기기 코드 로그인을 지원한다면 다음을 사용할 수 있습니다.

```sh
codex login --device-auth
```

기기 코드 방식은 계정 또는 워크스페이스에서 허용되어 있어야 합니다. 지원하지 않는 옵션이라고 표시되면 해당 CLI 빌드의 로그인 방법을 따르세요. 참고: [OpenAI Docs의 기기 코드 로그인 안내](https://learn.chatgpt.com/docs/auth#preferred-device-code-authentication-beta).

로그인 완료 후 확인합니다.

```sh
codex login status
```

인증 파일을 프로젝트에 복사하거나 GitHub에 올릴 필요가 없습니다.

## 2. 서버 플러그인 설치

### SillyTavern 서버 종료

SillyTavern이 실행 중인 터먹스 세션에서 `Ctrl+C`를 눌러 종료합니다. 설치 중에는 서버를 실행하지 않는 편이 좋습니다.

### SillyTavern 폴더로 이동

설치 위치가 홈의 `SillyTavern`인 경우:

```sh
cd ~/SillyTavern
pwd
ls config.yaml package.json server.js
```

폴더 이름이나 위치를 다르게 설치했다면 실제 경로로 바꾸세요. 마지막 명령에서 파일들이 보여야 합니다. `plugins` 안이나 브라우저 확장 폴더 안에서 다음 clone 명령을 실행하지 않습니다.

### Git으로 설치

```sh
git clone https://github.com/STLoft/Chatelier-Bridge.git plugins/Chatelier-Bridge
```

설치 확인:

```sh
ls plugins/Chatelier-Bridge/package.json plugins/Chatelier-Bridge/index.js plugins/Chatelier-Bridge/exec-transport.cjs
```

이미 폴더가 있으면 clone을 반복하지 말고 [업데이트](#업데이트)를 사용합니다. 플러그인 자체는 추가 npm 패키지가 필요하지 않습니다.

## 3. 서버 설정

먼저 설정 파일 사본을 보관합니다.

```sh
cp config.yaml config.yaml.before-chatelier
nano config.yaml
```

`nano`에서 `enableServerPlugins`를 찾아 기존 값을 다음처럼 바꿉니다.

```yaml
enableServerPlugins: true
```

Git 서버 플러그인 자동 업데이트를 쓰려면 다음 값도 확인합니다.

```yaml
enableServerPluginsAutoUpdate: true
```

기존 키가 있으면 그 값을 고치고 같은 키를 중복 추가하지 마세요. `nano`에서는 `Ctrl+O` → Enter로 저장하고 `Ctrl+X`로 나갑니다.

## 4. 서버 시작

SillyTavern 폴더에서 평소 사용하던 실행 명령으로 시작합니다. 일반적인 실행 예시는 다음과 같습니다.

```sh
node server.js
```

**이것만 실행하면 됩니다.** Chatelier-Bridge는 서버와 함께 로드되며 별도 브리지 명령이나 별도 포트가 필요하지 않습니다.

기본 주소를 사용하는 설치라면 휴대폰 브라우저에서 아래를 엽니다. 포트를 바꿨다면 실제 주소를 사용하세요.

```text
http://127.0.0.1:8000
```

## 5. 브라우저 확장 설치

1. SillyTavern 상단의 **확장 → 확장 설치**를 누릅니다.
2. 아래 주소를 붙여 넣습니다.

```text
https://github.com/STLoft/Chatelier
```

3. 설치 후 브라우저를 새로고침합니다.
4. **Chatelier → 설정**을 엽니다.
5. 엔진을 **Codex CLI**로 선택하고 상태를 새로고침합니다.
6. CLI 버전과 ChatGPT 로그인 상태를 확인합니다.
7. 모델 ID는 비워 두면 CLI 기본 모델을 사용합니다. 필요한 경우에만 직접 입력합니다.
8. 참조 이미지 등을 설정하고 **설정 저장**을 누릅니다.
9. AI 응답이 있는 대화방에서 **만들기** 탭을 열고 프롬프트를 작성합니다.
10. 프리셋을 저장하고 **이미지 생성**을 누릅니다.

프롬프트의 자리표시자에 선택한 대화 내용이 들어갑니다. 새 프리셋은 `{scene}`에서 시작하고, 기본 프리셋에는 편집 가능한 예시 프롬프트가 들어 있습니다. 프리셋 공유 방법은 [Chatelier의 프리셋 안내](https://github.com/STLoft/Chatelier#프롬프트와-프리셋)를 참고하세요.

## 평소 사용하는 순서

터먹스를 새로 열었을 때:

```sh
cd ~/SillyTavern
node server.js
```

브라우저에서 SillyTavern을 열어 Chatelier를 사용합니다. 끝낼 때는 서버 터미널에서 `Ctrl+C`를 누릅니다. Codex CLI 로그인이 유지된다면 매번 다시 로그인할 필요는 없습니다.

Android가 서버나 CLI를 강제로 종료한다면 터먹스 앱의 배터리 사용을 제한하지 않도록 설정하고, 필요한 동안 터먹스의 wake lock 기능을 사용할 수 있습니다. wake lock을 사용해도 모든 기기의 백그라운드 종료를 막을 수 있는 것은 아닙니다.

## 업데이트

### Chatelier-Bridge

서버를 `Ctrl+C`로 종료하고 SillyTavern 폴더에서 실행합니다.

```sh
cd ~/SillyTavern
git -C plugins/Chatelier-Bridge pull --ff-only
node server.js
```

브라우저 확장 Chatelier는 SillyTavern 확장 관리에서 업데이트한 뒤 새로고침합니다.

### 터먹스용 Codex CLI

위에서 안내한 `@mmmbuto/codex-cli-termux`를 npm으로 설치했다면, SillyTavern 서버를 시작할 때 새 버전을 확인하고 자동 업데이트합니다. 업데이트 전 패키지 파일은 `plugins/Chatelier-Bridge/workspace/cli-backups/`에 백업·검증합니다. 터먹스 패키지를 PC용 패키지로 바꾸지 않습니다.

업데이트 확인·진행 중에는 잠시 이미지 생성을 기다립니다. 설정 화면에서 완료 여부를 확인할 수 있습니다. 네트워크·권한 오류가 나면 다음 서버 시작 때 재시도합니다. 다른 CLI 빌드·설치 방식이라면 자동으로 덮어쓰지 않으며, 그 빌드의 업데이트 방법을 따르세요.

자동 업데이트를 끄고 시작하려면:

```sh
export ST_CODEX_AUTO_UPDATE=0
node server.js
```

다음은 수동 업데이트가 필요한 경우의 명령입니다.

위에서 안내한 커뮤니티 패키지로 설치한 경우에만 다음 명령을 사용합니다.

```sh
npm install -g @mmmbuto/codex-cli-termux@latest
codex --version
codex login status
```

다른 패키지로 설치했다면 그 패키지의 업데이트 절차를 따르세요. 수동 CLI 업데이트 후에는 SillyTavern도 다시 시작합니다.

## 터먹스 문제 해결

### `node`, `git`, `codex`: command not found

```sh
command -v node
command -v git
command -v codex
```

`node`와 `git`이 없다면 `pkg install git nodejs-lts`로 준비합니다. `codex`가 없다면 사용하는 터먹스용 CLI의 설치 상태를 확인합니다. 별도 Linux 환경이나 다른 터먹스 사용자 홈에 설치된 CLI와 섞이지 않아야 합니다.

### CLI는 되는데 플러그인에서는 찾지 못함

서버를 종료하고 SillyTavern 폴더에서 아래처럼 실행합니다.

```sh
export ST_CODEX_BIN="$(command -v codex)"
node server.js
```

`command -v codex` 자체가 비어 있다면 먼저 CLI 설치를 확인하세요. 새 터먹스 세션에서는 필요하면 환경변수를 다시 지정합니다.

### 터먹스인데 PC 방식으로 실행됨

자동 감지가 안 되는 환경에서는 서버 시작 전에 명시합니다.

```sh
export ST_CODEX_TRANSPORT=exec
node server.js
```

설정 상태와 모델 입력란이 exec 방식으로 바뀌었는지 확인합니다.

### `image_generation` 옵션 또는 도구가 없다고 표시됨

터먹스용 CLI 빌드와 버전을 확인합니다. 이 플러그인은 다음과 같은 CLI 기능이 있는 환경을 전제로 합니다.

```text
codex exec --skip-git-repo-check --sandbox workspace-write --enable image_generation --config approval_policy="never" --cd <작업 폴더> -
```

이 줄은 동작 설명용입니다. `<작업 폴더>`를 그대로 붙여 넣어 실행하지 않아도 됩니다. 프롬프트와 참조 이미지 전달은 플러그인이 처리합니다.

해당 옵션이 없거나 이미지 생성 도구가 제공되지 않으면 플러그인만 업데이트해서 해결되지 않을 수 있습니다. 지원하는 CLI 빌드·모델·계정 환경을 확인하세요.

### 생성이 계속 진행 중이거나 중간에 종료됨

브라우저의 취소 버튼을 누르고 서버 터미널의 오류를 확인합니다. exec 생성은 최대 8분을 기다립니다. Android의 절전·백그라운드 종료와 네트워크 상태도 확인하세요. 작업이 중단되었다면 서버를 종료 후 다시 시작합니다.

### 새 이미지 파일을 찾을 수 없다고 표시됨

이 방식은 작업 폴더와 CLI의 `generated_images`에서 새 파일을 찾습니다. 기존 이미지·참조 이미지를 성공 결과로 대신 반환하지 않습니다. 생성 도구가 실제 파일을 저장했는지와 CLI 오류를 확인하세요. Chatelier로 생성하는 동안 같은 CLI 환경의 다른 이미지 생성은 잠시 멈추는 것이 좋습니다.

### `destination path ... already exists`

이미 설치된 폴더입니다. `git -C plugins/Chatelier-Bridge remote -v`로 대상 저장소를 확인하고 [업데이트](#업데이트) 절차를 사용하세요. 생성 이미지가 들어 있을 수 있으므로 폴더를 무작정 지우지 마세요.

## 확인 범위

프롬프트 표준입력 전달, 새 결과 파일 탐지, 참조·기존 이미지 제외, 취소와 시간 초과는 모의 CLI로 검증합니다. Android 기기에서의 실제 이미지 생성은 CLI 빌드·계정에 따라 별도로 확인해야 합니다.
