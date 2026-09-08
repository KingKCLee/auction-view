# Dual Collector setup

목표: GitHub Actions 대신 무료 Oracle Cloud VM + Windows 노트북을 동시에 사용한다.

## 역할

- cloud master: 최신 공고, 과거 공고 백필, 기본정보, 노트북 delta 병합, 최종 auctions.json 게시
- laptop worker: 상세정보, 매각일정, 유찰결과, 낙찰가, 감정평가 요약, 문서 존재여부를 수집하고 작은 delta 파일만 GitHub에 게시
- GitHub: 코드와 결과 저장/Pages 게시. 수집 실행 서버로 사용하지 않는다.

노트북이 canonical data/auctions.json을 직접 커밋하지 않으므로 cloud master와 동시에 돌아도 대형 JSON 충돌을 피한다.

## Windows 노트북

관리자 PowerShell:

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
winget install --id OpenJS.NodeJS.LTS -e
gh auth login
gh auth setup-git
cd C:\
mkdir auction
cd auction
git clone https://github.com/KingKCLee/auction-view.git
cd auction-view
npm install
npx playwright install chromium
$env:BATCH_SIZE="12"
powershell -ExecutionPolicy Bypass -File .\scripts\laptop-collector.ps1
```

법원 접속 사전 확인:

```powershell
node -e "fetch('https://www.courtauction.go.kr').then(r=>console.log('COURT OK',r.status,r.url)).catch(e=>console.error('COURT FAIL',e.message))"
```

## Oracle Cloud master

Always Free eligible Ampere A1 Ubuntu VM을 사용한다. 무료 범위 초과를 피하려면 콘솔에서 Always Free eligible 표시를 확인하고 1 OCPU / 6 GB RAM 정도로 시작한다.

Ubuntu 접속 후:

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g npm@latest

# GitHub CLI
(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y

gh auth login
gh auth setup-git
git clone https://github.com/KingKCLee/auction-view.git
cd auction-view
npm install
npx playwright install --with-deps chromium
chmod +x scripts/cloud-master.sh
./scripts/cloud-master.sh
```

## 처리 흐름

1. cloud master가 최신/과거 기본정보를 canonical DB에 추가한다.
2. laptop worker가 최신 canonical DB를 pull한다.
3. laptop worker가 상세조회 12건을 처리한다.
4. laptop worker는 canonical JSON을 원상복구하고 변경된 필드만 data/worker-deltas/laptop/*.json으로 만든다.
5. cloud master가 delta를 읽어 canonical DB에 병합한 뒤 delta 파일을 삭제한다.
6. metrics-corrector가 통계를 다시 계산한다.

## 안전장치

- 법원에서 BLOCKED/CAPTCHA/접속거부 신호가 나오면 우회하지 않고 다음 주기로 넘긴다.
- 양쪽 장비 모두 5분 주기로 움직이지만 서로 다른 역할을 수행한다.
- 노트북은 data/auctions.json을 직접 push하지 않는다.
- cloud master만 canonical data/auctions.json을 게시한다.
- GitHub Actions 자동 스케줄은 두 장비가 정상 동작하는 것이 확인된 뒤 수동 비상용으로 전환한다.
