# rin

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**一つの runtime で、agent を terminal、chat、memory、time にまたがって動かす。**

**Rin** は、chat-connected agent のためのローカルファーストなランタイムです。設計の中心は「現在の作業ディレクトリ」ではなく「ユーザー」にあり、agent がコンテキスト、メモリ、ツール、スケジュール、配信面を一つにまとめ、セッションをまたいで動き続けられるようにします。

Rin が目指すのは、リポジトリごとに毎回作り直す一時的な補助役ではなく、長く育てていける agent runtime です。

## なぜ Rin なのか？

- **cwd ではなくユーザー中心。** Rin が追うのは、その時開いているリポジトリではなく人です。
- **多層メモリ。** メモリはランタイムに組み込まれた能力であり、一時的なチャットログに縮退しません。
- **TUI + Koishi。** ローカルのターミナルでも使え、同じランタイムをチャットプラットフォームにもつなげられます。
- **自己ブートストラップ。** Rin は、自分が動いているランタイム環境をそのまま点検し、利用し、整え続けられます。
- **タイマーと巡検が第一級。** バックグラウンド routine と inspection はネイティブな能力です。
- **All in agent。** 公開 CLI は小さく保ち、より豊かな振る舞いは agent runtime 自体から提供することで、すぐ使えて agent 自身でも設定しやすくしています。

## 短い manifesto

多くの agent ツールは、表面から始まります。
一つのコマンド、一つのエディタパネル、一つの作業ディレクトリ。

Rin は、連続性から始めます。

agent には、自分の memory、自分の routine、自分の interface、そして育ち続けられる runtime があるべきです。

一回きりの作業のための補助ではなく、
持ち続けられる runtime として。

## 全体像

```text
User
 ├─ terminal ──> Local TUI ────┐
 └─ chat ──────> Koishi bridge │
                               ├──> Rin agent runtime
                               │      ├─ memory
                               │      ├─ skills
                               │      ├─ models
                               │      ├─ schedules
                               │      └─ inspections
                               │
                               └──> persistent runtime state (~/.rin)
```

## 3 ステップでつかむ Rin

**1. Install**

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

**2. Launch**

```bash
rin
```

**3. 同じ runtime を育て続ける**

ローカル TUI で使い、チャットにもつなぎ、リポジトリごとに毎回リセットするのではなく、同じ agent runtime を積み上げていきます。

## クイックスタート

### 要件

- ユーザーレベル `systemd` を使える Linux 互換環境
- Node.js >= 22
- `npm`、`git`、`mktemp`

### クイックインストール

```bash
# 最新の main をインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 特定の ref をインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

### ソースからインストール

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

### Rin を起動

```bash
rin
```

## 典型的なユースケース

| | |
| :--- | :--- |
| **個人向けターミナル agent**<br>リポジトリをまたいでも、そのたびにゼロから始めなくてよい。 | **チャット接続型アシスタント**<br>ブリッジされたメッセージ基盤を通じて受信・処理・配信できる。 |
| **自己保守するランタイム**<br>agent 自身がドキュメント、スキル、メモリ、スケジュールを点検し、そのまま改善を続けられる。 | **バックグラウンド自動化の相棒**<br>定期 routine、周期的チェック、長寿命の agent ワークフローに向く。 |

## 位置づけ

| 問い | Rin | ターミナル型コーディングエージェント | IDE 中心型エージェント |
| :--- | :--- | :--- | :--- |
| **agent は何に属するか？** | ユーザー | 現在の shell / repo | 現在の editor workspace |
| **主にどこで出会うか？** | TUI とチャットブリッジ | CLI 実行 | エディタのパネルや拡張 |
| **表面を閉じた後はどうなるか？** | runtime 自体の連続性が残る | 多くはプロセス終了で終わる | 体験はエディタに結び付いたまま |
| **どれだけの機能が agent の内側にあるか？** | memory、routine、inspection、configuration | 主にタスク実行 | 主にエディタ補助 |
| **重心はどこか？** | 継続運用できる個人向け agent runtime | 直接的なターミナル作業 | エディタ内支援 |

*関連カテゴリの例として、Codex CLI、Claude Code、Gemini CLI のようなターミナル型エージェントや、Cursor、Windsurf、Cline のような IDE 中心型ツールがあります。*

## 公開コマンドサーフェス

Rin は公開 CLI を意図的に小さく保っています。

- `rin`: インタラクティブなローカル TUI を起動します。
- `rin restart`: バックグラウンドの Rin デーモンサービスを再起動します。
- `rin update`: 設定されたソースリポジトリと ref から Rin を再インストールまたは更新します。
- `rin uninstall --keep-state --yes`: インストール済みアプリとランチャーを削除しますが、`~/.rin` 内のデータは残します。
- `rin uninstall --purge --yes`: アプリと完全な `~/.rin` ランタイムを削除します。

## 同梱される機能

- **ローカル TUI** による対話型 agent セッション。
- **Koishi ベースのチャット接続** によるブリッジ配信。
- **ランタイム内蔵のメモリシステム**。
- **ネイティブな定期 routine と巡検能力**。
- **ランタイムのドキュメント、スキル、内部ツールを通じた agent 主導の設定**。
- **小さな公開コマンド面による、すぐ使える体験**。

## ドキュメント

- [ランタイムリファレンス](install/home/docs/rin/README.md)
- [TUI ガイド](install/home/docs/rin/docs/tui.md)
- [モデルとプロバイダ](install/home/docs/rin/docs/models.md)
- [スキル](install/home/docs/rin/docs/skills.md)
- [拡張](install/home/docs/rin/docs/extensions.md)
- [SDK](install/home/docs/rin/docs/sdk.md)
- [サンプル](install/home/docs/rin/examples/README.md)
- [開発ノート](install/home/docs/rin/docs/development.md)

## 開発

ローカルの変更を検証するには、以下を実行してください。

```bash
npm run check
```

貢献の詳細は [CONTRIBUTING.md](CONTRIBUTING.md) と [CODE_STYLE.md](CODE_STYLE.md) を参照してください。

## ライセンス

このプロジェクトは MIT ライセンスで提供されています。詳細は [LICENSE](LICENSE) を参照してください。
