# 울림 (Ulrim)

<p align="center">
  <img src="assets/icon.png" width="128" alt="울림 아이콘">
</p>

라이브 공연을 위한 사운드보드 데스크톱 앱.

효과음(SFX)과 넘버 MR을 패드 형태로 배치하고, 프리셋으로 관리할 수 있습니다.
JX-11 블루투스 리모컨을 연결하면 무대 위에서 핸즈프리로 사운드를 컨트롤할 수 있습니다.

## Features

- **사운드 패드** — 효과음 / 넘버 MR 섹션으로 구분된 패드 그리드
- **프리셋** — 공연별로 사운드 구성을 저장·전환
- **라이브러리** — 자주 쓰는 사운드 파일을 라이브러리로 관리
- **JX-11 리모컨** — 블루투스 HID 리모컨으로 재생/정지/트랙 이동 제어
- **Input Debug** — HID 입력 이벤트를 실시간 모니터링

## Getting Started

```bash
# 의존성 설치
npm install

# 개발 모드 실행
npm start

# Windows 빌드
npm run build
```

## Tech Stack

- Electron
- node-hid (JX-11 블루투스 리모컨 연결)

## License

ISC
