# rin

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**Rin** は、チャット連携型エージェントのワークフロー向けに設計されたローカルファーストなランタイムです。エージェントがスケジュール、自動化、および長期間のブリッジ配信を管理できる、安定したデーモン駆動の環境を提供します。単一のターミナルセッションやエディタウィンドウに縛られることはありません。

## なぜ Rin なのか？

Rin は、エージェントのエコシステムにおいて独自の地位を占めています。多くのツールが即時のコード生成やエディタ統合に焦点を当てている一方で、Rin は**ランタイムのルート**、つまりエージェントが継続的なアシスタントとして機能することを可能にする永続的なバックグラウンドレイヤーに焦点を当てています。

### 位置づけ

| 機能 | Rin | ターミナル型コーディングエージェント | IDE 中心型エージェント |
| :--- | :--- | :--- | :--- |
| **主なインターフェース** | ローカルランタイム & TUI | CLI コマンド | エディタ / 拡張機能 |
| **実行モデル** | 永続デーモン | タスク固有のプロセス | エディタに紐づくプラグイン |
| **状態管理** | 中央集約型 (`~/.rin`) | セッションベース | エディタのワークスペース |
| **ツールサーフェス** | 内部ランタイム API | CLI サブコマンド | エディタコマンド |
| **主な焦点** | 連携ワークフロー | 直接的なファイル編集 | エディタ内での支援 |

*関連するカテゴリの例には、Codex CLI、Claude Code、Gemini CLI などのターミナルエージェントや、Cursor、Windsurf、Cline などの IDE 中心型ツールが含まれます。*

## 主な特徴

- **ローカルファースト・ルート:** すべてのランタイム状態、メモリ、設定は `~/.rin` に保存されます。
- **デーモン駆動:** バックグラウンドサービスがブリッジ、スケジュール、自動化フローを処理し、UI が閉じられてもタスクが継続されることを保証します。
- **最小限の CLI サーフェス:** 公開される CLI は意図的に小さく保たれています。複雑なエージェント機能（ウェブ検索、メモリ、インスペクション）は、CLI の複雑さを増すのではなく、ランタイムのツールサーフェスを通じて公開されます。
- **ユーザーレベルの管理:** `systemd` と深く統合されており、管理されたサービスのライフサイクル（再起動、アップデート、ログ）を提供します。

## インストール

### クイックインストール
`systemd`、Node.js >= 22、`npm`、`git`、および `mktemp` を備えた Linux 互換環境が必要です。

```bash
# 最新の main をインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 特定のリファレンスをインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

### ソースからのインストール
```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## コマンドサーフェス

Rin は、作業の邪魔にならないよう、無駄のない CLI を維持しています。

- `rin`: インタラクティブなローカル TUI を起動します。
- `rin restart`: バックグラウンドの Rin デーモンサービスを再起動します。
- `rin update`: 設定されたソースリポジトリとリファレンスから Rin を再インストール/アップデートします。
- `rin uninstall --keep-state --yes`: アプリケーションとランチャーを削除しますが、`~/.rin` 内のデータは保持します。
- `rin uninstall --purge --yes`: アプリケーションと `~/.rin` ディレクトリを完全に削除します。

## ランタイムのレイアウト

ランタイムの状態は、ホームディレクトリ内に厳密に収められています。

- `~/.rin/`: 主要な状態のルート。
- `~/.rin/data/web-search/config.json`: ウェブ検索の設定。
- `~/.rin/bin/`: ランチャーとバイナリ。

## ウェブ検索

Rin は柔軟なウェブ検索ランタイム機能を備えています。Docker を介したローカルの **SearxNG** インスタンスの管理（オプションのサイドカー）、既存の SearxNG インスタンスへの接続、または **Serper** クレデンシャルの使用が可能です。設定は `~/.rin/data/web-search/config.json` で管理されます。

## 開発

### 必要条件
- Node.js >= 22
- ユーザーレベルの `systemd` を備えた Linux
- Docker（管理された SearxNG サイドカーを使用する場合のオプション）

### 検証
ローカルの変更を検証するには、以下を実行してください。
```bash
npm run check
```

貢献の詳細については、[CONTRIBUTING.md](CONTRIBUTING.md) および [CODE_STYLE.md](CODE_STYLE.md) を参照してください。内部ドキュメントは `install/home/docs/rin/README.md` にあります。

## ライセンス

このプロジェクトは MIT ライセンスの下でライセンスされています。詳細は [LICENSE](LICENSE) ファイルを参照してください。
