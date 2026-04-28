# Exchange Watch

은행 USD 환율과 국내 거래소 USDT/KRW 가격을 한 화면에서 비교하는 로컬 대시보드입니다.

## 실행

```powershell
npm run exchange:start
```

브라우저에서 `http://localhost:4177`을 엽니다.

포트를 바꾸려면:

```powershell
$env:EXCHANGE_WATCH_PORT=4188
npm run exchange:start
```

## 데이터

- 은행: 하나은행, KB국민은행, 우리은행 USD/KRW 상세표를 서버에서 조회해 현찰 살 때, 현찰 팔 때, 송금 보낼 때, 송금 받을 때를 표시합니다.
- 거래소: 업비트 `KRW-USDT`, 빗썸 `KRW-USDT` 공개 현재가 API를 조회합니다.
- 우대율: 현찰 살 때/팔 때와 매매기준율의 차이만큼을 스프레드로 보고, 입력한 우대율만큼 스프레드를 할인해 계산합니다.

실제 체결가는 은행/거래소 앱의 주문 화면, 호가, 수수료, 등급별 우대 조건에 따라 달라질 수 있습니다.

## 핸드폰 알림

서버는 은행 우대 적용 매수가와 업비트/빗썸 USDT 가격을 계속 비교합니다. 최저값과 최고값 차이가 설정값 이상이면 알림을 보냅니다.

기본 조건:

- 기준 차이: 10원 이상
- 확인 주기: 60초
- 같은 조건 재알림 제한: 10분
- 비교 대상: 하나은행/KB국민은행/우리은행 우대 적용 매수가, 업비트 USDT, 빗썸 USDT

웹 화면의 `환율 우대율`과 `알림 기준 차이`를 바꾸면 서버 알림 기준도 바로 변경됩니다. 이 값은 실행 중인 서버의 공통 설정이며, 서버가 재시작되면 환경변수 기본값으로 돌아갑니다.

### 카카오 알림톡

일반 사용자에게 카카오톡으로 자동 알림을 보내려면 카카오 알림톡/비즈메시지 계약이 필요합니다. 비즈고, 인포뱅크, 슈어엠 같은 딜러사 또는 메시징 사업자의 API를 고른 뒤, 그 API에 맞춘 중계 웹훅을 연결합니다.

서버가 중계 웹훅으로 보내는 설정 예시:

```powershell
$env:KAKAO_ALIMTALK_WEBHOOK_URL="https://your-message-relay.example.com/kakao/alimtalk"
$env:KAKAO_ALIMTALK_WEBHOOK_SECRET="relay-secret"
$env:KAKAO_ALIMTALK_TEMPLATE_CODE="EXCHANGE_GAP_ALERT"
$env:KAKAO_ALIMTALK_RECIPIENTS="01012345678,01098765432"
$env:ALERT_THRESHOLD_KRW=10
$env:ALERT_PREFERENCE_PERCENT=80
npm run exchange:start
```

중계 웹훅에는 이런 JSON이 전달됩니다.

```json
{
  "channel": "kakao_alimtalk",
  "templateCode": "EXCHANGE_GAP_ALERT",
  "recipients": ["01012345678"],
  "message": "[Exchange Watch] 10원 차이 감지 ...",
  "variables": {
    "spread": "10원",
    "lowName": "하나은행 우대 매수가",
    "lowPrice": "1,478.50원",
    "highName": "빗썸 USDT",
    "highPrice": "1,489.00원",
    "preferencePercent": "80%",
    "asOf": "2026. 4. 28. 오후 4:10:00"
  }
}
```

### 개발 테스트용 Telegram

Telegram은 빠른 개발 테스트용입니다. 일반 사용자 배포용 기본 채널은 카카오 알림톡으로 잡는 편이 맞습니다.

```powershell
$env:TELEGRAM_BOT_TOKEN="123456789:AA..."
$env:TELEGRAM_CHAT_IDS="123456789"
$env:ALERT_THRESHOLD_KRW=10
$env:ALERT_PREFERENCE_PERCENT=80
npm run exchange:start
```

여러 명에게 보내려면 쉼표로 구분합니다.

```powershell
$env:TELEGRAM_CHAT_IDS="123456789,987654321"
```

알림 상태 확인:

```text
http://localhost:4177/api/alerts/status
```

카카오톡 알림은 일반 개인 계정 메시지 발송보다 카카오 알림톡/비즈메시지 또는 카카오 채널 연동이 필요합니다. 알림톡 발송 실패 시 SMS/LMS 대체 발송을 함께 켜는 구성이 안정적입니다.
