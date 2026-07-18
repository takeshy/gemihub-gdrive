# gemihub-gdrive

GemiHub Desktopのactive project全体を、GemiHubが利用するGoogle Driveルートと同期するPluginです。GemiHubと同じ`_sync-meta.json`、Migration Tool token、暗号化済みrefresh tokenを使用します。

## 動作

- 1つのDesktop projectを1つのGemiHub Driveルートへ固定して接続
- project内の通常ファイルを同期
- `.git/`、`.llm-hub/`、`node_modules/`、GemiHub system files/foldersは除外
- Google Docs、Sheets、Slidesなど`application/vnd.google-apps.*`のネイティブファイルは除外（PDF、DOCX、XLSXなど実体を持つexport済みファイルは同期）
- text/binary、pathを含むflat Drive filename、renameに対応
- Pullはlocalに未Pushの変更があっても実行可能（該当ファイルはスキップして保持）
- 両側で変更されたファイルはconflictとしてファイルごとに`Keep local` / `Keep remote`で解消（選ばれなかった側はDriveの`sync_conflicts/`へタイムスタンプ付きでバックアップ）
- Pushによるremote削除はGemiHubの`trash/`へ移動
- Pullによるlocal削除は実行前に確認
- Pull/Pushは実行前にnew、modified、deleted、conflictの対象ファイル一覧を表示
- Pullは最大5ファイルを並列処理し、処理件数と現在のpathを表示

## GemiHub側の準備

1. GemiHubの暗号化を有効にする
2. `設定 → 同期 → 外部同期`から同期トークンを生成する
3. Desktopで同期したいprojectへ切り替える
4. PluginのDrive Sync viewへtokenを貼り付ける
5. GemiHubの暗号化passwordでunlockする

token生成時に`_encrypted-auth.json`がDriveへ出力されます。token自体は短時間で失効しますが、Pluginは暗号化されたrefresh tokenをPlugin storageへ保存し、以後GemiHubのtoken refresh endpointを利用します。

## Build

```bash
npm install
npm run check
npm test
npm run build
```

GitHub Releaseにはrepository rootの`manifest.json`、build後の`main.js`、`styles.css`をassetとして添付します。tagはmanifest versionと一致する`v0.1.2`形式にしてください。
