# Running GamePort Browser on GitHub

GitHub can't open a desktop window for you directly, so there are three ways to use it. Pick what you need:

| I want to... | Use |
|---|---|
| Check that the code works after every change | **Actions: Test** (automatic) |
| Get a Windows, Mac or Linux installer without installing Node | **Actions: Build installers**, then download from Releases |
| Run the browser window without installing anything locally | **Codespaces** (runs in your web browser) |

## 1. Put the project on GitHub

You need a free GitHub account.

**With the website:**
1. Unzip `gameport-browser.zip`.
2. On github.com click **+** > **New repository**. Name it `gameport-browser`, leave it empty (no README), and click **Create repository**.
3. In the unzipped folder, open a terminal and run the commands GitHub shows under "push an existing repository", which look like this:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/gameport-browser.git
git push -u origin main
```

**With the GitHub CLI** (`gh`):

```bash
git init && git add . && git commit -m "Initial commit"
gh repo create gameport-browser --private --source=. --push
```

Before you push, open `package.json` and replace the placeholder `you@example.com` in `author`. The Linux `.deb` build requires a real-looking author email.

## 2. Automatic tests (Actions: Test)

Nothing to set up. As soon as you push to `main` (or open a pull request), the **Test** workflow runs the proxy test suite on Ubuntu, Windows and macOS.

1. Open your repository and click the **Actions** tab.
2. Click the latest **Test** run. Three green checks mean the proxy works on all three systems.

## 3. Build installers (Actions: Build installers)

**Option A: publish a release (recommended).** Tag a version and push the tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow builds all three installers (about 5 to 10 minutes) and attaches them to a new release. Open the **Releases** section on the right side of your repository page and download the file for your system:

- Windows: `GamePort Browser Setup 1.0.0.exe`
- macOS: `GamePort Browser-1.0.0-arm64.dmg`
- Linux: `.AppImage` (run it directly) or `.deb` (`sudo apt install ./file.deb`)

Make the tag match the `version` in `package.json`, since the installer file names use that version.

**Option B: build without releasing.** Go to **Actions** > **Build installers** > **Run workflow**. When it finishes, open the run and download the installers from the **Artifacts** section at the bottom. They are kept for 90 days by default.

**Opening unsigned apps:** these builds are not code-signed, so your OS will warn you the first time.
- Windows: on the SmartScreen screen click **More info** > **Run anyway**.
- macOS: right-click the app and choose **Open**. If macOS says it is damaged, run `xattr -cr "/Applications/GamePort Browser.app"` once.
- Linux: `chmod +x *.AppImage` before running it.

The macOS build made on GitHub's runners targets Apple Silicon (M-series) Macs. For Intel Macs, build locally with `npm run dist` on that machine.

## 4. Run it in your browser with Codespaces

Codespaces gives you a Linux machine in the cloud with a desktop you view in a browser tab. The repository's `.devcontainer` folder sets this up.

1. On your repository page click **Code** > **Codespaces** > **Create codespace on main**.
2. Wait for setup to finish (a few minutes the first time; it installs the system libraries and runs `npm install`).
3. In the terminal at the bottom, run:

   ```bash
   npm run start:codespaces
   ```

4. Open the **Ports** tab, find port **6080** (Desktop), and click the globe icon to open it. Click **Connect** and enter the password `vscode`.
5. The GamePort window appears on that desktop. The toolbar chip should show the proxy running on `127.0.0.1:8080`.

Things to know about Codespaces:
- The script uses `--no-sandbox --disable-gpu` because containers can't run Chromium's sandbox or use a GPU. That is fine for trying the proxy, tabs and settings, but **don't use this mode for everyday browsing**, and **WebGL and video performance won't reflect a real machine**. Use an installer from step 3 for that.
- Stop the codespace when you're done (**Code** > **Codespaces** > the `...` menu > **Stop**) to save your free monthly hours.

## Updating later

Change the code, then:

```bash
git add . && git commit -m "Describe your change" && git push
```

Tests run automatically. To ship a new version, raise `version` in `package.json`, commit, and push a new tag such as `v1.0.1`.

## Troubleshooting

| Problem | Fix |
|---|---|
| Release job is skipped | It only runs for tags starting with `v`. Check you pushed the tag (`git push origin v1.0.0`). |
| Release job fails with a permissions error | In the repository go to **Settings** > **Actions** > **General** > **Workflow permissions** and select **Read and write permissions**. |
| `.deb` build fails mentioning an author email | Set a valid `author.email` in `package.json`. |
| Codespaces window never appears | Check the terminal for errors, confirm port 6080 is forwarded, and re-run `npm run start:codespaces`. |
| Red proxy chip in Codespaces | Port 8080 may be taken by the forwarding service. Run `npm run start:codespaces -- --proxy-port=9090`. |
