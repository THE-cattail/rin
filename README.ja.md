# rin

![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**あなたの agent に、小さな居場所を。**

**Rin** は、ローカルファーストな agent の相棒です。目指しているのは、その場しのぎの一回きりの手伝いではなく、だんだん息が合っていく助手をそばに置いておけること。プロジェクトや画面を切り替えるたびに最初からやり直すのではなく、同じ助手が少しずつ覚え、慣れ、付き添っていけるようにします。

小さな助手は、使い捨てでなくていい。
Rin は、そばに置いて、覚えて、少しずつ整っていく毎日の居場所を作ろうとしています。

## なぜ Rin なのか？

- **フォルダではなく人についてくる。** 助手の中心にあるのは、今開いているプロジェクトではなく使っている人です。
- **ちゃんと覚えていける。** 一時的な会話の切れ端を積むだけではなく、少しずつ持ち越していけます。
- **会える場所が一つではない。** ターミナルでも話せるし、チャットにもつなげられます。
- **自分で整っていける。** 自分のメモ、道具、ちいさなルールを読み返しながら、やり方を整えていけます。
- **静かに見守るのも得意。** 繰り返す用事や、時間を置いて見ておきたいことも、最初から役目のうちです。
- **最初から扱いやすい。** 表に見えるコマンドは少なく、いろいろな振る舞いは助手の内側に収まっています。

## 短い manifesto

多くの agent ツールは、表面から始まります。
コマンドひとつ。
パネルひとつ。
プロジェクトひとつ。

Rin は、続いていくことから始めます。

助手は覚えていていい。
自分のやり方を持っていていい。
居場所を持っていていい。
使う人と一緒に育っていっていい。

一回だけの小技ではなく、
長く置いておける相棒として。

## Rin がどうまとまっているか

```text
You
 ├─ terminal で話す ───┐
 └─ chat で話す ───────┤
                       ├──> Rin
                       │      ├─ いくつか覚える
                       │      ├─ 道具を使う
                       │      ├─ メモやルールを持つ
                       │      ├─ 繰り返しの用事をこなす
                       │      └─ 必要なときに静かに見る
                       │
                       └──> セッションをまたいで続いていく
```

## 3 ステップでつかむ Rin

**1. Install**

```bash
# 対話式セットアップ（保存先・provider・チャット連携を案内）
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# ランタイム保存先を指定
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --state-root ~/rin-home

# 環境を書き換えずにインストール手順だけ試す
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --dry-run
```

**2. Open**

```bash
rin
```

**3. 同じ助手をそばに置いておく**

ターミナルで使い、必要ならチャットにもつなぎ、プロジェクトごとに毎回リセットするのではなく、同じ助手を少しずつ育てていきます。

## クイックスタート

### 要件

- Linux・macOS・Windows（Windows では Git Bash など POSIX 系シェルから `install.sh` を実行）
- バックグラウンド daemon は `systemd`・`launchd`・detached process から利用可能なものを自動選択
- Node.js >= 22
- `npm`、`git`、`mktemp`

### クイックインストール

```bash
# 対話式セットアップで最新の main をインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# ランタイム保存先を指定してインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --state-root ~/rin-home

# 環境を書き換えずに結果だけ確認
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --dry-run

# 特定の ref をインストール
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

### ソースからインストール

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
./install.sh --local
```

### ローカル checkout から更新

```bash
cd /path/to/rin
rin update --local

# 別の checkout から既存 runtime を更新する場合
rin update --local --path /path/to/rin
```

### 起動

```bash
rin
```

## Use Cases

| | |
| :--- | :--- |
| **ターミナルのそばにいる個人用助手**<br>プロジェクトをまたいでも、毎回はじめましてになりません。 | **チャットでも話せる助手**<br>受け取って、考えて、送り返すところまで同じ助手に任せたいときに向きます。 |
| **自分で部屋を整えていく助手**<br>メモや習慣や道具を見返しながら、少しずつやり方を整えていけます。 | **静かな背景仕事の相棒**<br>繰り返しの用事、定期的な確認、長めに走る流れに向いています。 |

## ほかの agent 製品と比べると

| 問い | Rin | ターミナル型コーディングエージェント | IDE 中心型エージェント |
| :--- | :--- | :--- | :--- |
| **助手は誰のそばにいるか？** | 使う人のそば | 今の shell や repo | 今の editor workspace |
| **どこで会うことが多いか？** | terminal と chat | コマンド実行の場 | エディタのパネルや拡張 |
| **表面を閉じたあとどうなるか？** | 助手の流れは続いていく | 多くはプロセスと一緒に終わる | 体験はエディタに結びついたまま |
| **どれだけ助手の内側に入っているか？** | memory、繰り返し作業、見守り、整え方 | 主にその場の実行 | 主にエディタ内の補助 |
| **何を目指しているか？** | 長く一緒にいられる個人用助手の居場所 | ターミナルで作業するための道具 | エディタの中の補助役 |

*Examples of related categories include terminal agents like Codex CLI, Claude Code, or Gemini CLI, and IDE-centric tools like Cursor, Windsurf, or Cline.*

## 公開コマンド

Rin は、表に見えるコマンドを小さく保っています。

- `rin`: 現在のユーザー自身の runtime に対してローカルの対話画面を開きます。
- `rin -u <user>`: 権限がある場合、別ユーザーの Rin をそのまま開きます。
- `rin --tmux [<name>]`: Rin 専用の tmux socket 上で起動します。既定の `tmux list-sessions` には出ません。
- `rin --tmux-list`: その Rin 専用 tmux socket にある session name を一覧します。
- `rin restart`: バックグラウンドサービスを再起動します。
- `rin update`: 設定された取得元から再インストールまたは更新します。
- `rin uninstall --keep-state --yes`: アプリ本体を外し、保存された状態は残します。
- `rin uninstall --purge --yes`: アプリ本体と保存された状態の両方を外します。

## 最初から入っていること

- **ローカルの対話画面** で、そのまま助手と話せる。
- **チャットへの橋渡し** で、同じ助手が外でも話せる。
- **内蔵の memory** で、今の会話だけで終わらない。
- **繰り返しの用事や静かな見守り** が、最初から役目に入っている。
- **助手自身が整えに参加できる作り** で、メモ、道具、内側の説明を見ながら調整できる。
- **表面は軽く、本事はもっと内側にある。**

## Pi を土台に

Pi は成熟した agent runtime であり、堅牢な session モデル、幅広い provider / model 対応、実用的な terminal UI、そして拡張にきちんと使える SDK / extension を備えています。

Rin はその基盤の上で、ローカルファーストな持続型の個人用 assistant runtime へと重心を移しています。一回きりの session や単一の repo を中心にするのではなく、memory、chat bridge、定期実行、そして助手自身の notes / rules を session をまたいで持ち運べるようにしています。

## Documentation

- [Runtime reference](install/home/docs/rin/README.md)
- [Examples (source repo)](examples/pi/README.md)

## Development

ローカルの変更を確かめるには、次を実行してください。

```bash
npm ci
npm run check
npm run check:container
```

`npm ci` を実行すると、Git checkout ではローカルの Husky hooks も設定されます。`pre-push` hook が push 前に `npm run check:container` を自動実行するので、ローカルで Docker が使える必要があります。

詳しくは [CONTRIBUTING.md](CONTRIBUTING.md) と [CODE_STYLE.md](CODE_STYLE.md) を参照してください。

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
