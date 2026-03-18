# rin

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

`rin` は、チャット接続型のエージェント運用向けローカルファーストランタイムです。

## できること

- 対話実行の `rin`
- デーモン再起動の `rin restart`
- リポジトリ ref からの更新用 `rin update`
- ランタイム削除用 `rin uninstall`
- `~/.rin` に保存されるランタイム状態

Rin はソースチェックアウトではなく、インストール後の `~/.rin` から動作します。

## 必要環境

- Node.js 22+
- npm
- git
- 現在のインストーラーフローに対応した Linux 系環境

## インストール

現在のユーザーにインストール:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

特定 ref を使う場合:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  RIN_REF=main sh
```

既存ユーザー向けにインストール:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  sh -s -- --user existing-user --yes
```

## 日常コマンド

対話モード開始:

```bash
rin
```

デーモン再起動:

```bash
rin restart
```

インストール済みランタイム更新:

```bash
rin update
```

リポジトリや ref を指定して更新:

```bash
rin update --repo https://github.com/THE-cattail/rin.git --ref main
```

`~/.rin` を残してアプリだけ削除:

```bash
rin uninstall --keep-state --yes
```

完全削除:

```bash
rin uninstall --purge --yes
```

## ソースから開発する

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

検証を実行:

```bash
npm run check
```

## リポジトリ構成

```text
src/                 ランタイム実装
install.sh           ブートストラップインストーラー
install/home/        install 時に ~/.rin へコピーされる標準ファイル
test/                自動テスト
```

## ランタイム構成

```text
~/.rin/
  AGENTS.md
  app/current/
  auth.json
  data/
  docs/
  locale/
  settings.json
  skills/
```

インストール後のランチャー:

```text
~/.local/bin/rin
```

## ライセンス

[MIT](LICENSE)
