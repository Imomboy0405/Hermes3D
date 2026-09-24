# Agent Office: Claude Code'ni ofisga ulash

Har bir Claude Code sessiyasi ofisda xodim bo'lib ko'rinadi. Subagentlar yordamchi xodimlar sifatida chiqadi. Limit va model ma'lumotlari status line orqali keladi.

```
Claude Code ── http hook ──► claude-gateway-adapter (ws://localhost:18789) ◄── Hermes3D Studio (localhost:3000)
            └─ status line ─┘
```

## Birinchi marta sozlash

```bat
cd C:\dev\agent-office\Hermes3D
npm install
npm run claude:install
```

`claude:install` quyidagilarni qo'shadi:

- `%USERPROFILE%\.claude\settings.json` ga 15 ta `http` hook;
- status line.

O'zgartirishdan oldin zaxira nusxa olinadi. Sizda boshqa status line bo'lsa, u o'chirilmaydi va biznikiga qo'shilib ishlaydi.

Hook'lar sessiya boshida o'qiladi, shuning uchun o'rnatgandan keyin ochiq Claude Code sessiyalarini qayta ishga tushiring.

Olib tashlash: `npm run claude:uninstall`.

## Har kuni ishga tushirish

`start-office.bat` faylini ikki marta bosing. U ikkita oyna ochadi (adapter va Studio), keyin brauzerda `http://localhost:3000/office` sahifasini ochadi.

Qo'lda ishga tushirish uchun ikkita terminal kerak:

```bat
npm run claude-gateway
npm run dev
```

Birinchi ochilishda ulanish oynasi chiqadi. Unda **Demo backend** ni tanlang, manzil `ws://localhost:18789` bo'lsin. Adapter o'zini "demo" deb tanishtiradi, shuning uchun UI'ni o'zgartirish kerak emas.

> Asl `npm run demo-gateway` bir xil portni ishlatadi. Ikkalasi bir vaqtda ishlamaydi.

## Nima qayerda ko'rinadi

| Claude Code | Ofisda |
|---|---|
| Sessiya ochildi | Yangi xodim keladi. Ismi proekt papkasidan olinadi |
| Prompt yubordingiz | Xodim ishlay boshlaydi |
| Tool (Edit, Bash, Grep...) | Xodim holatida "🔧 Edit login_page.dart" kabi yozuv chiqadi |
| Ruxsat so'radi | "✋ Ruxsat kerak" ogohlantirishi chiqadi |
| Subagent | Yordamchi xodim paydo bo'ladi, ish tugagach 20 soniyadan keyin ketadi |
| Javob tugadi | Oxirgi javob gap pufakchasida ko'rinadi, xodim bo'shaydi |
| Sessiya yopildi | Xodim ofisdan chiqib ketadi |

Model belgisi: 🟣 Opus, 🔵 Sonnet, 🟢 Haiku, 🟠 Fable/Mythos.

## Tekshirish va nosozliklar

- `http://localhost:18789/state` sahifasida adapter ko'rayotgan barcha sessiyalar va limitlar chiqadi.
- `http://localhost:18789/usage` sahifasida 5 soatlik va haftalik limit ko'rinadi. Bu ma'lumot Claude'ning birinchi javobidan keyin paydo bo'ladi.
- `set AGENT_OFFICE_DEBUG=1` qilib adapterni ishga tushirsangiz, har bir hook konsolda ko'rinadi.
- Holat `%USERPROFILE%\.agent-office\claude-state.json` fayliga saqlanadi. Adapterni qayta ishga tushirsangiz, xodimlar joyida qoladi.
- Adapter ishlamayotgan paytda Claude Code odatdagidek ishlayveradi. Hook'lar hech narsani bloklamaydi.

## Doimiy jamoa

`~/.claude/agents/` dagi har bir subagent fayli, shuningdek ochiq proektlarning `.claude/agents/` papkasidagilari ofisda **doimiy xodim** bo'lib turadi:

- boshida hammasi bo'sh holatda o'tiradi;
- Claude Code biror agentga ish topshirsa, o'sha xodim ishlay boshlaydi, ish tugagach yana bo'shaydi;
- bir turdagi agent bir vaqtda ikki marta chaqirilsa, ikkinchisi vaqtinchalik yordamchi (`explorer #2`) bo'lib chiqadi va ish tugagach ketadi;
- agent fayli qo'shilsa yoki o'chirilsa, ofis avtomatik yangilanadi.

Limit panelidagi **Jamoa** bo'limida kim band ekani va qaysi sessiya uchun ishlayotgani ko'rinadi.

Agentlar faqat ishlayotganda ko'rinishini istasangiz, adapterni `set AGENT_OFFICE_ROSTER=0` bilan ishga tushiring.

## Limit paneli

Ofisning o'ng yuqori burchagida **Claude limit** paneli turadi. Unda quyidagilar ko'rinadi:

- 5 soatlik va haftalik limit, har biri qachon yangilanishi bilan;
- har bir xodimning holati, modeli (Opus / Sonnet / Haiku) va context to'lganlik darajasi;
- subagentlar o'z sessiyasi ostida `↳` belgisi bilan.

Panel sarlavhasini bossangiz, u yig'iladi.

Model ikki manbadan olinadi: status line'dan va sessiya transcript'idan. Shu sababli Claude desktop ilovasidagi sessiyalarning modeli ham ko'rinadi. Limit esa faqat terminaldagi status line'dan keladi.

Ofis nomini sozlamalardagi (⚙) **Office title** maydonida o'zgartirish mumkin.

## Til

Interfeys standart holatda o'zbekcha. Tilni limit panelining pastki qismidagi **Til** qatoridan almashtirasiz: O'zbekcha yoki English.

Tarjima `src/lib/i18n/uz.ts` lug'atida saqlanadi. `src/components/UiTranslator.tsx` esa ekrandagi inglizcha matnni shu lug'at bo'yicha almashtiradi. Komponentlarning o'zi o'zgartirilmagan, shuning uchun `git pull upstream main` konfliktsiz o'tadi. Agentlarning javoblari, kod va kiritish maydonlari tarjima qilinmaydi.

Hali inglizcha qolgan matnni ko'rsangiz, uni `uz.ts` ga qo'shing. Kalit ekranda qanday yozilgan bo'lsa, xuddi shunday bo'lishi kerak.

## Hozircha yo'q

- Ruxsatni ofisdan tasdiqlash. Hozircha ruxsat terminalda beriladi, ofis uni faqat ko'rsatadi.
