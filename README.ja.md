# rin

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

チャット接続されたエージェントワークフローのためのローカルファーストなランタイム。

## 必要条件

- Node.js >= 22
- npm, git, mktemp
- Linux 互換環境

## インストール

`install.sh` を使用してインストールします。注意：`rin install` は公開コマンドではありません。

```bash
# 標準インストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 特定の ref を指定してインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

ランチャーは `~/.local/bin/rin` にインストールされます。

### ソースからのインストール

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## 使い方

- **起動**: `rin` (対話モードを開始)
- **再起動**: `rin restart` (バックグラウンドデーモンを再起動)
- **アップデート**: `rin update` 
- **カスタムアップデート**: `rin update --repo https://github.com/THE-cattail/rin.git --ref main` 

## アンインストール

- **データを残す**: `rin uninstall --keep-state --yes` 
- **完全に削除**: `rin uninstall --purge --yes` 

## データ保存先

ランタイムのデータや状態は `~/.rin` に保存されます。