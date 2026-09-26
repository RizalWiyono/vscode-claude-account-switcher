<p align="center">
  <img src="images/icon.png" width="128" alt="Logo Claude Account Switcher">
</p>

<h1 align="center">Claude Account Switcher</h1>

<p align="center">
  Pindah antar akun Claude Code dari status bar VS Code tanpa login ulang,<br>
  sekaligus melihat pemakaian 5 jam dan mingguan setiap akun.
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

---

```
👤 Kantor  〰 5h 12%  7d 64%
```

## Fitur

- **Ganti akun sekali klik.** Klik tombol di status bar, pilih akun, selesai. Tidak perlu `/login` lagi.
- **Simpan otomatis.** Setiap akun yang login lewat Claude Code (`/login`) otomatis tersimpan.
- **Pemakaian sekilas.** Pemakaian 5 jam dan mingguan setiap akun, lengkap dengan bar dan waktu reset. Status bar jadi kuning di 80% dan merah di 95%.
- **⭐ Sisa kuota terbanyak.** Akun lain diurutkan berdasarkan sisa kuota, dan yang terbaik diberi bintang.
- **Notifikasi reset.** Muncul pemberitahuan saat limit yang tadinya tinggi sudah reset, dengan tombol untuk pindah ke akun itu.
- **Percakapan tetap lanjut.** Setelah ganti akun, percakapan yang sama bisa dilanjutkan dengan akun baru, atau mulai percakapan baru.
- **Label dan warna.** Beri nama akun ("Kantor", "💼 Pribadi") dan warna. Defaultnya menampilkan email.
- **Deteksi sesi rusak.** Sesi tersimpan yang sudah dicabut atau kedaluwarsa ditandai ❌ dengan tombol login ulang, jadi ganti akun tidak pernah membuat Claude Code ter-logout.

## Kebutuhan

- VS Code 1.90 atau lebih baru
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (extension VS Code atau CLI) yang login dengan akun Claude (Pro, Max, Team…)
- Windows, macOS, atau Linux

Login dengan API key tidak didukung, karena tidak ada akun yang bisa ditukar.

## Instalasi

1. Download `claude-account-switcher.vsix` dari [halaman Releases](https://github.com/RizalWiyono/vscode-claude-account-switcher/releases), atau build sendiri (lihat [Development](#development)).
2. Di VS Code: **Extensions** → `···` → **Install from VSIX…**, atau jalankan:
   ```bash
   code --install-extension claude-account-switcher.vsix
   ```
3. Jalankan **Developer: Reload Window**.

## Cara pakai

### Menambahkan akun

1. Akun yang sedang login otomatis tersimpan.
2. Login dengan akun berikutnya: klik status bar → **Add another account…** → **Open Terminal**, ketik `/login`, lalu masuk.
   > ⚠️ Pakai `/login`, **jangan** `/logout`. Logout akan mencabut sesi tersimpan akun yang sedang aktif.
3. Akun baru tersimpan begitu login selesai. Ulangi untuk setiap akun.

### Ganti akun

Klik status bar dan pilih akun. Setelah itu ada beberapa pilihan:

| Pilihan | Yang terjadi |
|---|---|
| **Resume Conversation** | Restart extension, lalu membuka lagi percakapan terakhir dengan akun baru. |
| **New Conversation** | Membuka percakapan baru dengan akun baru. Tidak ada yang di-restart. |
| **Restart Extensions** | Hanya extension yang di-restart. Editor dan terminal tetap terbuka. |
| **Reload Window** | Reload seluruh window VS Code. |

Supaya tidak ditanya setiap kali, atur `claudeSwitcher.afterSwitch`.

Percakapan yang sudah terbuka tetap memakai akun lama sampai di-restart atau di-resume. Pesan pertama setelah melanjutkan percakapan panjang dengan akun lain memakan kuota lebih banyak, karena cache prompt tidak dibawa antar akun. Kalau percakapannya panjang, jalankan `/compact` dulu.

### Label dan warna

Klik 🏷️ di samping akun (atau jalankan **Claude: Set Account Label**). Kosongkan label untuk kembali menampilkan email.

## Perintah

| Perintah | Keterangan |
|---|---|
| `Claude: Switch Account` | Buka daftar akun (sama dengan klik status bar) |
| `Claude: Set Account Label` | Atur label dan warna akun |
| `Claude: Refresh Usage` | Perbarui data pemakaian sekarang |
| `Claude: Save Current Account` | Simpan akun yang sedang login secara manual (biasanya otomatis) |
| `Claude: Remove Saved Account` | Hapus akun tersimpan |

## Pengaturan

| Setting | Default | Keterangan |
|---|---|---|
| `claudeSwitcher.afterSwitch` | `ask` | Aksi setelah ganti akun: `ask`, `resume`, `newConversation`, `restartExtensions`, `reloadWindow`, `nothing` |
| `claudeSwitcher.refreshIntervalMinutes` | `5` | Interval update pemakaian (menit) |
| `claudeSwitcher.warningThreshold` | `80` | Persen pemakaian saat status bar jadi kuning (merah di 95%) |
| `claudeSwitcher.notifyOnReset` | `true` | Notifikasi saat limit di atas batas peringatan sudah reset |

## Cara kerja

Claude Code menyimpan login di dua tempat. Saat ganti akun, keduanya ditukar:

| | Windows / Linux | macOS |
|---|---|---|
| Token | `~/.claude/.credentials.json` | Item Keychain `Claude Code-credentials` |
| Info akun | `oauthAccount` di `~/.claude.json` | sama |

Kalau `CLAUDE_CONFIG_DIR` diatur, folder itu yang dipakai, bukan `~/.claude`.

Semua yang lain dipakai bersama oleh semua akun dan tidak disentuh: skills, plugins, agents, hooks, settings, MCP server, dan riwayat percakapan. Yang terikat ke akun claude.ai mengikuti akunnya masing-masing: connector (Gmail, Drive…), skill organisasi, akses model, dan limit.

## Privasi & keamanan

- Token tersimpan di **VS Code SecretStorage**, yang memakai keychain OS (Windows Credential Manager, macOS Keychain, libsecret di Linux). Token tidak dikirim ke mana pun selain ke Anthropic.
- Extension hanya menghubungi Anthropic:
  - `api.anthropic.com/api/oauth/usage` untuk membaca pemakaian
  - `platform.claude.com` / `console.anthropic.com` untuk memperbarui token akun yang tidak aktif
- Sebelum setiap ganti akun, salinan file yang diubah disimpan di `~/.claude-switcher-backup/` dan hanya bisa dibaca oleh Anda.
- Tidak ada telemetri atau analitik.

## Mengatasi masalah

| Masalah | Solusi |
|---|---|
| `rate limited, retry in Xm` | Endpoint pemakaian dibatasi. Data terakhir tetap ditampilkan dan akan dicoba lagi otomatis. |
| ❌ *Saved session expired or was revoked* | `/login` ulang ke akun itu. Tandanya hilang otomatis. |
| `claude` tidak dikenali di terminal | Pakai **Add another account… → Open Terminal**, yang menjalankan CLI bawaan extension Claude Code. |
| Pemakaian tidak muncul | Data pemakaian berasal dari endpoint tidak resmi yang bisa berubah. Fitur ganti akun tetap jalan walaupun pemakaian tidak muncul. |

## Development

```bash
npm install          # sekali saja
npm run compile      # build ke out/
npm run watch        # build ulang otomatis saat disimpan
npm run package      # buat claude-account-switcher.vsix
code --install-extension claude-account-switcher.vsix --force
```

Tekan `F5` di VS Code untuk membuka Extension Development Host.

## Disclaimer

Extension ini dibuat secara independen oleh komunitas dan **tidak berafiliasi dengan, tidak didukung oleh, dan tidak di-support oleh Anthropic**. "Claude" dan "Claude Code" adalah merek dagang Anthropic, PBC. Extension ini bergantung pada perilaku Claude Code yang tidak terdokumentasi dan bisa berubah sewaktu-waktu. Gunakan dengan risiko sendiri.

## Pembuat

Dibuat oleh **Rizal Wiyono**.

## Lisensi

[MIT](LICENSE) © 2026 Rizal Wiyono
