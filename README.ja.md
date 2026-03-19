# rin

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-2ea44f)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

チャット接続されたエージェントワークフローのためのローカルファーストなランタイムです。

## これは何か

`rin` は公開 CLI を小さく保ち、実際の重心をローカルのランタイムルートに置きます。

- `rin` はローカルの対話 TUI を起動します
- バックグラウンドデーモンがブリッジ、スケジュール、オートメーションを扱います
- ランタイム状態は `~/.rin` に集約されます
- ブリッジ配信、メモリ、検査、スケジュール、Web 検索などの内部機能は、公開 CLI を増やすのではなくランタイム / ツール面で提供します

## どこが違うのか

Rin は、単なるターミナル上のモデルラッパーでも、IDE シェル中心の製品でもありません。

- **ローカルファースト** — 状態、ドキュメント、スキル、ランタイムデータは `~/.rin` に集約
- **デーモン前提の設計** — 自動化やチャット接続フローをランタイムの標準形として扱う
- **公開面を小さく維持** — サポートする CLI は起動、再起動、更新、アンインストールに絞る
- **ランタイム優先** — agent 向けの機能はランタイム側に置き、公開 CLI を肥大化させない

## 他の agent 製品との位置づけ

Rin は、機能数の比較よりも「どこを中心に据えるか」の違いで捉えるのが分かりやすいです。

| 製品の形 | 典型的な中心 | Rin の位置づけ |
| --- | --- | --- |
| Codex CLI、Claude Code、Gemini CLI のようなターミナル型 agent | 現在のリポジトリに紐づくアクティブなターミナルセッション | Rin は持続するローカルランタイムルートと、デーモンに支えられたチャット接続ワークフローを中心に置きます |
| Cursor、Windsurf、Cline のような IDE 型 agent | エディタ画面とその拡張のライフサイクル | Rin はワークフローをローカルランタイムに置き、公開 CLI を意図的に小さく保ちます |

持続するローカル状態とバックグラウンドワークフローを中心にした agent runtime が欲しいなら、Rin はそのための形です。

## 必要条件

- Linux 互換環境
- 管理されたデーモンの再起動 / 更新フローにはユーザー単位の `systemd` が必要
- Node.js >= 22
- `npm`、`git`、`mktemp`
- Docker は任意。ローカル管理の SearxNG サイドカーを使う場合のみ必要

## インストール

`install.sh` でインストールします。`rin install` は意図的に公開していないコマンドです。

```bash
# main ブランチをインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 特定の ref を指定してインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

ランチャーは `~/.local/bin/rin` に配置されます。

### ソースからインストール

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## クイックスタート

1. `rin` を実行してローカルの対話モードを開きます。
2. ランタイム関連のファイルは `~/.rin` にまとめます。
3. デーモン管理のランタイム設定やブリッジ設定を変更したら `rin restart` を実行します。
4. 更新時は `rin update` で設定済みのソースから再インストールし、ランタイムを更新します。

## 公開コマンド面

| コマンド | 目的 |
| --- | --- |
| `rin` | ローカルの対話 TUI を起動 |
| `rin restart` | ユーザー単位の Rin デーモンサービスを再起動 |
| `rin update` | 設定済みのソースリポジトリ / ref から再インストール |
| `rin uninstall --keep-state --yes` | アプリとランチャーを削除し、`~/.rin` は保持 |
| `rin uninstall --purge --yes` | アプリと `~/.rin` を両方削除 |

## ランタイム構成

- `~/.rin` — ランタイムルート
- `~/.rin/data` — ランタイムデータとデーモン状態
- `~/.rin/docs/rin` — インストール時に同梱されるローカルのランタイムリファレンス

## Web 検索

Web 検索のランタイム設定は `~/.rin/data/web-search/config.json` にあります。

デフォルトでは、Rin はローカルの SearxNG サイドカーを管理できます。自分の SearxNG インスタンスを指定したり、Serper の資格情報を設定したりすることもできます。

## 開発

```bash
npm ci
npm run check
```

`npm run check` はビルド、単体テスト、インストール / 更新 / アンインストールの smoke tests、そしてリポジトリの可搬性 / ドキュメント整合性チェックをまとめて実行します。

関連ドキュメント:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_STYLE.md](CODE_STYLE.md)
- [ランタイムリファレンス](install/home/docs/rin/README.md)

## アンインストール

```bash
rin uninstall --keep-state --yes
rin uninstall --purge --yes
```

## ライセンス

MIT
