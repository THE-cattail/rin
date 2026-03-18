# rin

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

`rin` は、チャット接続型のエージェント運用を前提にしたローカルファーストのランタイムです。

## このリポジトリに含めるもの

公開リポジトリには、再利用しやすく共有しやすい内容だけを置きます。

- `src/` の TypeScript 実装
- GitHub からの導入用ブートストラップ `install.sh`
- インストール時に `~/.rin` へ配置する公開ドキュメント資産 `install/home/`
- CI とコントリビューション用の補助ファイル

実行時の状態や個人データは `~/.rin` に残し、ソースチェックアウトとは分離します。

## 必要環境

- Node.js 22+
- npm
- git

## インストール

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

特定の ref を使う場合:

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  RIN_REF=main sh
```

## 更新

```bash
rin update
```

## アンインストール

状態を残してアプリだけ削除:

```bash
rin uninstall --keep-state --yes
```

完全削除:

```bash
rin uninstall --purge --yes
```

## ソースから開発する場合

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

検証:

```bash
npm run check
```

## ランタイム配置

ライブ状態は `~/.rin` に保存されます。主な内容:

- `AGENTS.md`
- `settings.json`
- `auth.json`
- `data/`
- `docs/`
- `skills/`
- `locale/`
- 必要に応じて生成される `kb/` や `routines/`

`~/.local/bin/rin` は `~/.rin/app/current/dist/index.js` を指します。

## 公開コマンド

- `rin`
- `rin restart`
- `rin update`
- `rin uninstall`

メモリ、ブリッジ、スケジュールなどはランタイム内部機能であり、公開シェルサブコマンドではありません。

## 開発方針

- 端末固有・環境固有の前提を避ける
- 再現可能な install / build / update を優先する
- 振る舞い変更時はドキュメントと自動検証も更新する
- 公開コードとローカル実行状態の境界を明確に保つ

詳細は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

[MIT](LICENSE)
