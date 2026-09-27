# midi-kbd

[English](README.md) | 日本語

MIDIキーボードをつないで、ブラウザでグランドピアノ音源（Splendid Grand Piano）を弾くアプリ。
MIDIファイルを再生して、降ってくるノート・五線譜・楽譜で追うこともできる。

## できること

- MIDIキーボード・画面の鍵盤・PCキーボードで演奏する
- SFZ音源で鳴らす。5段階のベロシティ、弦共鳴、ハーフペダルを再現している
- リバーブ・EQ・ダンピングを調整する。設定はブラウザに保存される
- MIDIファイルを再生し、ノート・五線譜・楽譜の3種類の表示で追う

## 動作環境

| ブラウザ | MIDIキーボード | 画面の鍵盤・PCキーボード |
|---|---|---|
| Chrome / Edge | ✅ | ✅ |
| Firefox 108以降 | ✅ | ✅ |
| Safari | ❌ | ✅ |

ローカルで動かすにはNode.jsが必要（22で動作確認）。

## セットアップ

1. 依存パッケージを入れる

   ```bash
   npm install
   ```

2. 音源（約75MB）をプロジェクト直下の`sfz/`に取得する

   ```bash
   git clone https://github.com/sfzinstruments/SplendidGrandPiano.git sfz/SplendidGrandPiano
   ```

音源を別の場所に置く場合は、その親フォルダを環境変数`SFZ_ROOT`で指定する
（例: `D:/SoundFonts/SplendidGrandPiano`に置いたなら`SFZ_ROOT=D:/SoundFonts`）。

## 起動

Windowsでは`start.bat`をダブルクリックすると、サーバーが起動してブラウザが開く。
コマンドラインからは次のとおり。

```bash
npm start     # http://localhost:5173を開く
```

PCではページを開くと音源の読み込みが自動で始まる。ブラウザの自動再生の制限により、音が出るのは
画面をクリックするかキーを押してから（MIDIキーボードの打鍵は操作に数えられない）。スマホでは、
開いただけで約75MBを読み込まないよう「▶ 開始」ボタンを押してから読み込む。
サーバーを止めるときはコンソールで<kbd>Ctrl</kbd>+<kbd>C</kbd>。

`index.html`を直接（`file://`で）開いても動かない。Web MIDI APIは`http://localhost`
などのsecure contextでしか使えない。

## 使い方

- MIDIキーボードは、つなぐと自動で認識される
- 画面の鍵盤は、クリックした位置の上下で強さ（ベロシティ）が変わる
- PCキーボードは<kbd>Z</kbd>–<kbd>M</kbd>がC3のオクターブ、<kbd>Q</kbd>–<kbd>I</kbd>がC4のオクターブ、<kbd>Space</kbd>がサスティンペダル
- MIDIファイルは、プルダウンのプリセットから選ぶか、画面にドロップする（「ファイルを選ぶ」からも開ける）。
  `midi/`以下に置いた`.mid`がプリセットに並び、サブフォルダがグループになる
- 再生中は「ノート / 五線譜 / 楽譜」で表示を切り替えられる。「ch.10を無視」をオンにすると、
  ドラムのチャンネルを鳴らさない
- ヘッダーの「設定を初期化」で、保存したつまみの設定を初期値に戻せる

## 留意点

- 鍵盤を押してから音が出るまでに遅延がある。ブラウザはOS標準の音声出力を使うため、
  Windowsでは数十msになりやすい。目安はヘッダーのLatencyに表示される。
  Bluetoothのイヤホンや、HDMIでつないだモニターのスピーカーは遅延が大きいので、
  有線のイヤホンやオーディオインターフェイスを使うとよい
- 音源を全部メモリに展開するため、ブラウザのメモリを約535MB使う
- 楽譜はMIDIから自動で起こしたもので、実際の楽譜と同じにはならない。1段に3声以上が
  重なる曲（フーガなど）では、声部が省略される
- 自分で`midi/`に置くMIDIファイルは、公開や再配布をする前にライセンスを確認すること

## 公開

`npm run build`で、サーバー側の処理が要らない静的サイトを`dist/`に組み立てる。
Cloudflare Workersの静的アセットとして公開する場合は、`wrangler.jsonc`を用意して
`npm run cf:deploy`を実行する。

## ライセンス

MITライセンス（[LICENSE](LICENSE)）。

- 音源のSplendid Grand Pianoは、AKAIがpublic domainとして公開したサンプルをkinwieが
  SFZ化したもの（弦共鳴とハーフペダルはP. Eastman）
- 同梱している`midi/piano-midi.de/`の3曲はBernd Krueger（http://piano-midi.de/）の作品で、
  [CC BY-SA 3.0 DE](https://creativecommons.org/licenses/by-sa/3.0/de/deed.en)で配布されている。ファイル名だけを曲名に変えている

