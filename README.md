# Savepoint

Savepoint is a single-account game collection manager backed by MySQL or MariaDB. Add games, record their platforms, editions, and play status, and attach cover images. The interface supports Polish and English, twenty-two themes, and optional animated backgrounds. You can filter the collection and import or export it as JSON. Optional Gemini features identify games from photos, find covers, and suggest duplicate entries for review. The browser interface runs without a frontend build step.

## Requirements

- A hostname that resolves to your server and an HTTPS certificate trusted by the browser. A public deployment needs its own domain or hosting subdomain.
- Apache 2.4 with PHP-FPM and access to files outside the document root.
- A supported PHP release, version 8.2 or later. Enable `session`, `PDO`, `pdo_mysql`, `curl`, and `fileinfo` in the PHP-FPM version that serves the site. Optional SMTP notifications also need `openssl`. Use PHP CLI to generate the application password hash, run scheduled cleanup, and run the migration script if needed. Enable `pdo_mysql` for migrations. On panel-only hosting, you can generate the hash on your computer and import the schema in the hosting panel. [Supported PHP versions](https://www.php.net/supported-versions.php)
- MySQL or MariaDB with InnoDB and `utf8mb4` support, accessible from the PHP server.
- A Cloudflare account and a Turnstile widget for the application domain. The server and browser both need HTTPS access to `challenges.cloudflare.com`, and PHP must have a working CA trust store for certificate validation.

GitHub Pages serves static files. Deploy the running application to a PHP host. [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site#static-site-generators)

## 1. Set up directories and HTTPS

Choose a dedicated hostname and point its DNS records to your host as directed by your provider. Issue and install a TLS certificate for that hostname. The examples use `savepoint.example.com` and `/var/www/savepoint`. Replace them with your own values throughout.

Use the hostname's document root as `public/`. If your hosting panel calls it `httpdocs` or `public_html`, use that name instead. Keep `private/` next to the document root, under the same parent directory. The API resolves `private/savepoint/` from this exact relationship. Serve the app at the root of its hostname.

```text
/var/www/savepoint/
├── public/                       # DocumentRoot
│   ├── .htaccess
│   ├── index.html, favicon.*
│   ├── *.js, *.css               # the root-level files listed below
│   ├── assets/                   # luna-reef.webp, mountain-aurora.svg
│   └── api/                      # games.php, index.php, .htaccess, .user.ini
└── private/
    └── savepoint/
        ├── config.local.php
        ├── session-check-limits/  # writable by PHP
        ├── collection/
        │   ├── TransferStore.php
        │   └── uploads/          # writable by PHP
        ├── covers/
        │   ├── CoverBackup.php
        │   └── images/            # writable by PHP
        ├── ai/                   # modules, optional private keys and runtime files
        │   └── uploads/          # writable by PHP
        └── mail/                 # optional
```

On shared hosting, select the PHP-FPM version and document root in the domain panel. Confirm that requests for PHP run through PHP-FPM and that Apache honors the shipped `.htaccess` files, including `DirectoryIndex`, access restrictions, headers, and rewrite rules. Apache needs `mod_dir`, `mod_authz_core`, `mod_headers`, and `mod_rewrite`. The rewrite rules also need either `FollowSymLinks` or `SymLinksIfOwnerMatch` enabled for the document root. Enable `mod_filter` and `mod_deflate` if you want the bundled compression rules for public assets. [Apache .htaccess guide](https://httpd.apache.org/docs/2.4/howto/htaccess.html)

On a self-managed Apache server, start the PHP-FPM pool for the site. Enable `mod_ssl`, `mod_proxy`, and `mod_proxy_fcgi` in addition to the modules above. Make sure Apache listens on port `443` and use the following HTTPS virtual host as a starting point. Use your own certificate paths and the socket of the PHP-FPM pool. The Apache process must be allowed to connect to that socket. [Apache FastCGI handler documentation](https://httpd.apache.org/docs/2.4/mod/mod_proxy_fcgi.html#examples)

```apache
<VirtualHost *:443>
    ServerName savepoint.example.com
    DocumentRoot "/var/www/savepoint/public"

    SSLEngine on
    SSLCertificateFile "/path/to/fullchain.pem"
    SSLCertificateKeyFile "/path/to/privkey.pem"

    <Directory "/var/www/savepoint/public">
        Options +FollowSymLinks -Indexes
        AllowOverride All
        Require all granted

        <FilesMatch "\.php$">
            SetHandler "proxy:unix:/path/to/php-fpm.sock|fcgi://localhost/"
        </FilesMatch>
    </Directory>
</VirtualHost>
```

Set up a redirect from HTTP and any aliases to the canonical HTTPS address. PHP normally receives `HTTPS=on` or `HTTPS=1`. If a trusted proxy terminates TLS, configure Apache or PHP-FPM to set `HTTPS` from that trusted connection. Alternatively, set the `SAVEPOINT_TRUSTED_HTTPS_PROXY` environment variable for PHP to the exact upstream IP PHP sees as `REMOTE_ADDR` and make the proxy overwrite `X-Forwarded-Proto` with the connection scheme. Disable direct public access to the backend listener when using a proxy. Keep API and private cover responses out of shared caches and forward session cookies to PHP. If `open_basedir` is enabled, allow access to `private/savepoint/` and, for file-based sessions, the PHP session save path.

If you manage Apache directly, enable `mod_alias`, make sure Apache listens on port `80`, and add this separate virtual host for the redirect.

```apache
<VirtualHost *:80>
    ServerName savepoint.example.com
    Redirect permanent / https://savepoint.example.com/
</VirtualHost>
```

For local development, run the same Apache, PHP-FPM and database layout on your computer. Use a development hostname you control and a browser-trusted development certificate. Set `app_origin` to the exact HTTPS origin, including a nondefault port if used. For a complete sign-in test, create a separate Turnstile widget for that hostname. Cloudflare's dummy validation response omits the action that Savepoint checks. Keep the development credentials in your private deployment directory. [Turnstile testing documentation](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)

## 2. Copy the deployment files

Run these commands from the repository directory on the server, with an account that can write to the deployment directories. If you use SFTP or a file manager, create the directories shown above, copy the same files with hidden files visible, and set their permissions as shown. The commands copy the templates only when the private configuration files are absent. When upgrading, back up the application's source, private configuration, database, and cover store first. Preserve the existing private configuration and stored covers during installation.

```bash
site_root=/var/www/savepoint
public_root="$site_root/public"
private_root="$site_root/private/savepoint"

install -d -m 755 "$public_root/api" "$public_root/assets"
if [ ! -d "$site_root/private" ]; then
  install -d -m 700 "$site_root/private"
fi
install -d -m 700 "$private_root" \
  "$private_root/session-check-limits" "$private_root/covers" "$private_root/covers/images" \
  "$private_root/collection" "$private_root/collection/uploads" \
  "$private_root/ai" "$private_root/ai/uploads"

install -m 644 .htaccess app.js favicon.ico favicon.png favicon.svg "$public_root/"
install -m 644 aero-background.js session-api.js collection-transfer.js "$public_root/"
install -m 644 ai-import.js ai-import.css duplicates.js duplicates.css "$public_root/"
install -m 644 appearance.js static-background-colors.js \
  pipes.js maze.js matrix.js p2-clock.js "$public_root/"
install -m 644 base.css theme-skins.css luna.css retro.css mac.css seven-themes.css console-themes.css \
  classic-background.css classic3-background.css matrix-background.css \
  theme-menu.css static-background-colors.css "$public_root/"
install -m 644 assets/luna-reef.webp assets/mountain-aurora.svg "$public_root/assets/"
install -m 600 server/covers/CoverBackup.php "$private_root/covers/CoverBackup.php"
install -m 600 server/collection/TransferStore.php "$private_root/collection/TransferStore.php"
install -m 600 server/ai/Routes.php server/ai/PhotoImport.php \
  server/ai/CoverFinder.php server/ai/ConfirmedGames.php \
  server/ai/DuplicateDetector.php server/ai/DuplicateGames.php server/ai/prune.php "$private_root/ai/"

if [ ! -e "$private_root/config.local.php" ]; then
  install -m 600 api/config.example.php "$private_root/config.local.php"
fi
if [ ! -e "$private_root/ai/config.local.php" ]; then
  install -m 600 server/ai/config.example.php "$private_root/ai/config.local.php"
fi
if [ ! -e "$private_root/ai/cover-config.local.php" ]; then
  install -m 600 server/ai/cover-config.example.php "$private_root/ai/cover-config.local.php"
fi

install -m 644 api/.htaccess api/.user.ini api/index.php api/games.php "$public_root/api/"
# Replace the entry page last, after every resource it references is installed.
install -m 644 index.html "$public_root/"
```

Set the owner of the `700` private directories and `600` private files to the PHP-FPM pool user. If you deploy as a different user, set the owner in the hosting panel or ask your administrator. PHP-FPM needs write access to `session-check-limits/`, `covers/images/`, `collection/uploads/`, `ai/` and its session save path if it stores sessions in files. Apache needs read access to the public files and traverse access to the public directory and its parents. Keep the repository, configuration, tests, scripts, and backups outside the document root. Keep `private/` outside the site's URL space, including aliases and symbolic links.

Deploy all listed public files, including both artwork assets. Preserve the stylesheet and script order in `index.html`. `base.css` and `theme-skins.css` contain shared presentation rules. `aero-background.js`, `session-api.js`, and `collection-transfer.js` load before `app.js`. The appearance controllers restore preferences before the page paints. The remaining theme assets and AI dialog scripts load as needed. For an upgrade, upload the assets before replacing `index.html`, and check that the browser receives the updated files at their versioned URLs. Update the `v=` query value when you change a versioned file.

On a self-managed server, run `apachectl configtest` now that the document root exists. Reload Apache once the syntax check passes. If a proxy serves files in front of Apache, make sure it also enforces the private file restrictions. Step 5 checks what the site returns over HTTPS.

### Upgrade from v1.15

1. Back up your installation as described under [Collection, cover storage, and maintenance](#collection-cover-storage-and-maintenance).
2. Run the installation block above against the existing deployment. Keep `private/savepoint/config.local.php`, your database and the stored covers. Upload the listed public assets and private modules before replacing `index.html`. This release uses the same schema as v1.15.
3. If you want Gemini photo import, cover lookup, or duplicate detection, follow [Optional Gemini features](#optional-gemini-features). Schedule the [temporary-upload cleanup](#remove-expired-temporary-uploads) and run the [deployment checks](#5-verify-the-deployment).

## 3. Configure the database and application account

Create a dedicated database for Savepoint, such as `savepoint`, and a database user for the application. Grant that user `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on this database. Use the database's local or private network endpoint and the exact database and user names shown by your provider, including any prefixes. Edit `private/savepoint/config.local.php` on the server and fill in the following values.

| Keys | Value |
| --- | --- |
| `app_origin` | The application's canonical HTTPS origin, such as `https://savepoint.example.com`. Include the port if it differs from `443`. Omit the path, trailing slash, query string, and fragment. |
| `host`, `port`, `database`, `username`, `password` | The database connection details from your hosting panel. `port` is an integer and defaults to `3306`. Use `127.0.0.1` for a local TCP connection if your database account allows it. |
| `app_username` | The case-sensitive username for the single application account, up to 128 UTF-8 bytes, with no control characters or leading or trailing spaces. Choose it separately from the database username. |
| `app_password_salt`, `app_password_hash`, `app_password_iterations` | The three values produced by the command below. The salt and hash are hexadecimal strings, and the iteration count is an integer. |
| `turnstile_site_key`, `turnstile_secret_key` | The two keys for your Cloudflare widget. Set both before the first sign-in. |
| `cover_blocked_ipv4` | An optional array of public IPv4 addresses that the cover backup module must avoid, such as addresses belonging to your own infrastructure. |

Generate a salt and hash for a new application password. This Bash command reads the password without displaying it and passes it to PHP through standard input.

```bash
(
    IFS= read -r -s -p 'Application password: ' savepoint_password || exit 1
    printf '\n'
    printf '%s' "$savepoint_password" | php -r '
        $password = stream_get_contents(STDIN);
        if (strlen($password) < 16 || strlen($password) > 1024) {
            fwrite(STDERR, "Enter a password between 16 and 1024 bytes long.\n");
            exit(1);
        }
        $salt = random_bytes(32);
        $iterations = 600000;
        printf("    \x27app_password_salt\x27 => \x27%s\x27,\n", bin2hex($salt));
        printf("    \x27app_password_hash\x27 => \x27%s\x27,\n", hash_pbkdf2("sha256", $password, $salt, $iterations, 64));
        printf("    \x27app_password_iterations\x27 => %d,\n", $iterations);
    '
)
```

Replace the three matching entries in `config.local.php` with the command's output. For any values you type into the PHP array, write a backslash as `\\` and a single quote as `\'` inside single-quoted strings. Enter the password itself when you sign in. To change it, generate and save a fresh set of all three values. Keep the configuration files and password hashes private.

Initialize the schema using one of these methods.

- **Hosting panel, fresh installation.** Open the dedicated database in your panel or phpMyAdmin and import `api/schema.sql` from the repository. Confirm that the database contains the `games` and `login_throttle` tables. Use a database account with permission to create the tables.
- **PHP CLI, fresh installation or upgrade.** Use a separate migration account with `CREATE`, `ALTER`, `INDEX`, and `INSERT` on the dedicated database. Back up an existing database before upgrading. Create `migrate.local.php` from `api/config.example.php` in a private directory outside the document root and repository. Give it mode `600`, fill in only the migration account's database settings, and make sure the CLI user can read it. Run the command below from the repository directory with a PHP CLI that has `pdo_mysql`. Replace the example path with the location of your migration configuration. A successful run exits with status `0` and leaves both tables in place. [MySQL privileges for ALTER TABLE](https://dev.mysql.com/doc/refman/8.0/en/alter-table.html)

```bash
php scripts/migrate.php /path/to/private/migrate.local.php
```

Keep using the application database account in the live configuration. The application sign-in account comes from `config.local.php`, and a fresh database starts with an empty collection.

## 4. Enable Turnstile

In the Cloudflare dashboard, go to **Turnstile → Add widget**, choose **Managed** mode, and add the exact hostname from `app_origin` without the scheme or port. Create the widget and save its sitekey as `turnstile_site_key` and its secret key as `turnstile_secret_key` in `private/savepoint/config.local.php`. The API sends the sitekey to the browser and verifies the token, hostname, and `login` action on the server. [Cloudflare widget setup](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/)

If you have PHP CLI access on the server, check the edited configuration with `php -l /var/www/savepoint/private/savepoint/config.local.php`, substituting your own path. Run it as a user who can read the private file.

## 5. Verify the deployment

From a terminal, replace the example URL with your configured origin and run these checks without a session cookie.

```bash
app_origin=https://savepoint.example.com
curl -sSI "$app_origin/"
curl -i "$app_origin/api/games.php"
for path in /api/ /api/config.local.php /api/schema.sql \
  /private/savepoint/config.local.php /private/savepoint/ai/config.local.php \
  /private/savepoint/ai/cover-config.local.php; do
  curl -sS -o /dev/null -w "%{http_code} $path\n" "$app_origin$path"
done
```

The homepage should return `200` with a `Content-Security-Policy` header. The API should return `401` with `Content-Type: application/json`, `Cache-Control: no-store`, `authRequired: true`, and a `captcha` object whose `provider` is `turnstile`. This request verifies that PHP can read the private configuration. Sign-in and a test save verify the database connection and schema. `/api/` should return `403`. The file checks should return `403` or `404`. Resolve any different result before entering credentials in the browser.

1. Open the HTTPS address from `app_origin` in a private browser window. The sign-in screen should load. Wait for the Turnstile check and complete it if prompted, then sign in with `app_username` and the password you used to generate the hash.
2. Add a test game, edit it, refresh to check that it was saved, and delete it. Switch the interface to English and back to Polish to verify both languages. Test import and export on a disposable collection before replacing any existing data.
3. Open **Menu → Theme** in English or **Menu → Motyw** in Polish. Check that all twenty-two choices appear and the expanded menu is fully visible on desktop and a narrow screen. Test Aero's color, default-color reset and motion settings; Luna's aquarium; Mountain Lion's aurora; both background choices for Classic, Classic 3 and DOS; and P2's clock against the viewing device's local time. Check color changes and **Restore default color** separately for the Classic backgrounds in Classic, Classic 3 and DOS, and for Platinum and Bee. Refresh to check that the browser remembers each preference independently. Confirm there are no missing theme CSS, script or artwork requests in the browser's network panel.
4. Sign out and refresh. The sign-in screen should retain the selected theme and hide the collection and appearance controls. Sessions expire after 30 minutes of inactivity or 8 hours from sign-in. Passive checks and cover downloads do not extend those limits.

| Symptom | What to check |
| --- | --- |
| The API returns `426` | The certificate, the virtual host's HTTPS settings, and the `HTTPS` variable seen by PHP. |
| The API returns `403` when saving or signing in | The address in the browser must match `app_origin`, including the port. |
| The API returns `500` or `503` | Check the PHP-FPM and Apache error logs. Verify PHP's access to the private configuration, the required values, `pdo_mysql` in PHP-FPM, the database connection, and both tables. If sessions fail, check the PHP session save path and `session-check-limits/` permissions. |
| The widget fails to load or sign-in reports a verification error | Check that both keys belong to the widget, the hostname is exact, the browser and PHP can reach Cloudflare, and certificate validation succeeds. |
| The API returns `429` | Wait for the `Retry-After` interval if provided. For repeated AI errors, also check the application's `hourly_limit` and the provider quota. |
| Import fails on an otherwise valid JSON file | Check the file and game-count limits below, JSON formatting, and write access to the private collection upload directory. Confirm that a proxy forwards the JSON request bodies and permits the full 64 KiB per request. |
| A theme is unstyled, its menu is clipped, or an optional background is missing | Check the assets listed in step 2 against the network panel. Preserve their stylesheet order and versioned references from `index.html`. Canvas failures fall back to the original Classic desktop for maze, pipes and Matrix, or a plain violet desktop for P2. |
| A desktop color control is missing or reset seems to use the wrong color | Use the Classic background in Classic, Classic 3 or DOS. Animated alternatives do not expose their hidden desktop's color. Platinum and Bee always offer their desktop color. Each theme has its own saved value and original default; Aero has a separate picker and reset. Check that `static-background-colors.js` and `static-background-colors.css` loaded. |
| The P2 clock shows a different time or moves without smooth animation | Check the viewing device's clock and time zone. P2 uses local device time, not server time. With Background motion off it still updates once per second while visible. |

## Optional Gemini features

### Configure Gemini and the cover catalogs

1. Create a Gemini API key for your own Google AI project. In `private/savepoint/ai/config.local.php`, set `enabled` to `true` and enter the key in `api_key`. Keep `model` set to `gemini-3.5-flash-lite`, the model this release supports. PHP needs verified outbound HTTPS access to `generativelanguage.googleapis.com`. [Gemini API key setup](https://ai.google.dev/gemini-api/docs/api-key) · [Gemini model documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
2. To search SteamGridDB, enter your key as `steamgriddb_key` in `private/savepoint/ai/cover-config.local.php`. The server needs HTTPS access to `www.steamgriddb.com`. [SteamGridDB API settings](https://www.steamgriddb.com/profile/preferences/api)
3. To search IGDB, register a confidential Twitch application. Save its credentials in the same cover configuration as `igdb_client_id` and `igdb_client_secret`. The server obtains a token from `id.twitch.tv` and searches `api.igdb.com`. [IGDB account creation and authentication](https://api-docs.igdb.com/#account-creation)

Either catalog can be configured independently. When neither provides a suitable cover, the app checks English Wikipedia for article images without a separate catalog key. PHP needs HTTPS access to `en.wikipedia.org` for the fallback, and the browser needs access to sources such as `upload.wikimedia.org` to display the returned images. Savepoint uses the configured application origin as the contact website in Wikimedia's `User-Agent` header. Gemini checks whether the available cover metadata matches the game and platform. [MediaWiki PageImages documentation](https://www.mediawiki.org/wiki/Extension:PageImages#API) · [Wikimedia User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy)

The supplied configuration starts disabled. Keep service credentials, quota files, and the cached IGDB access token in the private `ai/` directory. Set `hourly_limit` to an integer from `1` to `100`. The application applies separate hourly counters to photo recognition, manual cover lookups, Gemini cover checks, and duplicate scans. Failed provider attempts can consume a slot. Manage provider quotas and billing through your own integration accounts.

### Use and verify AI workflows

- **Add Games AI.** Choose a JPEG, PNG, or WebP up to 12 MiB and 48 megapixels, or take a photo on a supported device. The browser prepares a JPEG up to 1600 pixels on its longest side and 2 MiB. Selecting **Identify games** sends that resized image to Gemini via Savepoint. Review up to 32 suggestions, correct titles and platforms, choose which entries to keep, and confirm before adding them. Cover URLs are editable. If automatic cover matching is unavailable, review the recognized games and add cover URLs manually.
- **Find cover with AI.** In the add or edit form, enter a title and select a platform. This sends title and platform queries and cover metadata without a photo. Review the result, replace or clear the suggested URL if needed, then save the form. Use the available manual cover search links when automatic matching finds no suitable result.
- **Find duplicates.** Open the duplicate review and choose **Check with Gemini**. The app shortlists possible matches and sends titles, platform names, and temporary option numbers for evaluation. Select the entry to keep, choose **Merge entries** or **Remove the other entry**, then confirm the change. A merge combines platform selections and supports retaining both physical and digital formats. It keeps the selected entry's title, status, and cover. Select **Check more pairs with Gemini** when the review offers it. Start a fresh scan if records change or the review expires.

Camera access starts when you choose **Take photo** and grant browser permission on a secure origin. File selection remains available when the camera is unavailable. Photo selection and preview stay in the browser until you choose **Identify games**. Use sample data to test both add and edit cover lookups, photo selection, camera permission, and a duplicate review. Cancel the drafts if you only want to check the suggestions.

Photo uploads use retryable chunks within the 64 KiB request limit. They expire after 15 minutes, and the server removes a claimed upload before calling Gemini. Set up the private cleanup command below to remove expired uploads even when the feature is idle.

## Appearance and language

After signing in, open **Menu → Theme** to change appearance. In Polish the category is **Motyw**. The sign-in screen has a language selector but no appearance controls. The browser remembers the selected theme and applies it to both the sign-in screen and the collection. Aero is the default for a new browser or an invalid saved choice. Appearance preferences belong to the browser; they are independent of the account, interface language and saved game data.

The available themes are **Aero, Luna, Classic, Classic 2, Classic 3, Platinum, Aqua, Mountain Lion, Liquid Glass, Old Linux, U Linux, F Linux, Bee, DOS, Longhorn, P1, P2, Dream, GC, Like to Play, X and X360**.

- **Aero** provides the original ribbon background, a background color picker, **Restore default color**, and a motion switch. Reset restores Aero's original blue.
- **Luna** provides an aquarium background and a motion switch. Its local reef image loads when Luna is selected; blue water remains visible while it loads or if it is unavailable.
- **Classic** offers the original **Classic** desktop or **3D Maze**. **Classic 3** separately offers **Classic** or **3D Pipes**. **DOS** offers **Classic** or **Matrix**, a locally rendered falling-text animation. Each optional canvas renderer starts only when requested, and a failure falls back to that theme's original desktop. The three background choices are remembered independently.
- **Desktop colors** can be changed for the **Classic** backgrounds in Classic, Classic 3 and DOS, and for Platinum and Bee. Each theme has an independent saved color and **Restore default color** button. Reset restores that theme's own original color, preserving Platinum's pattern and Bee's woven background. Changing these colors does not recolor the animated maze, pipes or Matrix alternatives.
- **Mountain Lion** uses the bundled aurora artwork as its desktop background.
- **P2** displays a clock background based on the viewing device's current local time. Changes to the device clock or time zone are reflected while the background is active. It requires no time service or server-side configuration. If canvas rendering is unavailable, a plain violet desktop remains visible.
- **Background motion** is available for Aero, Luna and an active maze, pipes, Matrix or P2 background. Turning it off pauses decorative animation; P2's functional clock continues to update once per second. The system's reduced-motion preference applies until the visitor saves an explicit choice. Background work pauses when the page is hidden or suspended, and inactive renderers do not animate other themes.
- Some console themes provide library, search and add-game shortcuts. These reuse the existing collection actions.

Choose **English** or **Polski** with the language selector. This translates the interface and selects the language of optional sign-in email notifications for that login. Stored titles, platforms and other collection values are preserved when changing language or theme. Themes and backgrounds use the bundled assets and local rendering; they need no additional API credentials or database migration.

## Collection, cover storage, and maintenance

Use **Menu → Export data** to save a JSON copy of the collection. It contains game entries and cover URLs. Export before importing, because a confirmed **Import data** replaces the collection in a single database transaction. Imports accept up to 16 MiB and 5,000 games. Larger requests are sent in chunks within the API's 64 KiB per-request limit. If an older browser-only collection could not be transferred, use **Download the older collection** to save its JSON and **Remove the older local copy** to clear it from that browser after saving.

Savepoint keeps retrieved cover copies in `private/savepoint/covers/images/`. New downloads use verified outbound HTTPS, including when an older cover URL uses HTTP. The server resolves cover hostnames through Google Public DNS, checks the returned addresses, and rejects local or blocked destinations. Allow outbound HTTPS on TCP port 443 to `dns.google` and the public hosts that serve your cover images. Use `cover_blocked_ipv4` for other public addresses that belong to your infrastructure. The store limit is 5 MiB per image and 512 MiB in total. If more space is needed, Savepoint can reclaim unreferenced cover copies at least 90 days old. Sign-in is required to access stored copies. [Google Public DNS over HTTPS](https://developers.google.com/speed/public-dns/docs/doh/)

For a full installation backup, keep the MySQL or MariaDB database, the private configuration, the matching application release, and `covers/images/` in protected storage outside the repository and document root. Protect or remove old JSON exports and database dumps according to your own retention needs. When restoring an installation, restore the matching application files and private modules, recover the database and covers, and verify the HTTPS deployment checks above.

### Remove expired temporary uploads

For file cleanup, run the private CLI command as the PHP-FPM pool user or the hosting account that owns the private upload directories. It prunes abandoned photo uploads after their 15-minute lifetime and staged collection uploads after their two-hour lifetime. It operates on the temporary upload directories only.

```bash
php /var/www/savepoint/private/savepoint/ai/prune.php
```

Schedule the same command at a short interval, such as every 15 minutes. In a hosting panel, choose a scheduled PHP script or CLI command so the path stays private. With a user crontab, substitute your own PHP CLI binary path and deployment directory.

```cron
*/15 * * * * /usr/bin/php /var/www/savepoint/private/savepoint/ai/prune.php
```

## Optional sign-in email notifications

Create `private/savepoint/mail/` with permissions `700`. Copy `server/mail/LoginNotifier.php` and the bundled `server/mail/phpmailer/` directory into it. Create `smtp.local.php` beside `LoginNotifier.php` from `server/mail/smtp.local.example.php` with permissions `600`. Set the SMTP hostname, integer port `465` with implicit TLS, the full sending mailbox address as both `username` and `from`, its SMTP password, and the recipient address in `to`. PHP-FPM needs read access to these files. The server needs outbound access on port `465` and a trust store that accepts the SMTP certificate. Sign in on the configured instance and check the notification. It contains the account name, sign-in IP address and time, and uses the interface language selected at sign-in.

## Tests

Run the suites from the repository directory with a supported Node.js release and PHP CLI. Use PHP with `pdo_sqlite` for the in-memory collection and duplicate-action tests, along with `curl`, `fileinfo`, and sessions for the AI route fixtures. The AI HTTP test also needs `proc_open` and permission to open a loopback socket. The suites use synthetic data and temporary files.

```bash
for test_file in tests/frontend-*.cjs; do
  case "$test_file" in
    tests/frontend-dom.cjs|tests/frontend-performance.cjs) continue ;;
  esac
  node "$test_file" || exit 1
done
for test_file in tests/backend-{security,session,collection,cover-backup,mail,ai-batch,ai-cover-search,ai-import,ai-routes,ai-duplicate-detector,ai-duplicates-actions}.php; do
  php "$test_file" || exit 1
done
```

The frontend suites cover session handling, collection import, appearance, photo import, cover lookup, and duplicate review. The AI HTTP route test starts a PHP test server on the loopback interface and substitutes provider responses. Complete the browser checks in step 5 for rendered CSS and native controls, including P2's clock, Mountain Lion's artwork, and the shared theme styles.

The performance test compares the current frontend with an earlier version of `app.js`. Supply the path to the file you want to use as the baseline.

```bash
node tests/frontend-performance.cjs /path/to/previous/app.js
```

`tests/backend-concurrency.php` runs separately against a real InnoDB database. It requires PHP CLI with `pdo_mysql` and `pcntl`, a disposable test database initialized from `api/schema.sql`, and the variables `TEST_DB_ISOLATED=1`, `TEST_DB_DSN`, `TEST_DB_USER`, and `TEST_DB_PASSWORD`. See the script header for the DSN format. Use credentials for the test database.

## Publishing the source on GitHub

For a first publication, create an empty GitHub repository and leave its automatic README, license, and `.gitignore` options blank. Authenticate Git with GitHub and run the commands from the directory that contains this README. Before committing, review the staged changes for credentials, personal data, configuration, exports, archives, and private server addresses. The source distribution requires only application code, assets, tests, empty configuration templates, and documentation. Keep your deployment files and data outside the repository. [Adding local code to GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

```bash
git init -b main
git add .
git diff --cached --name-only
git diff --cached --check
git diff --cached
git commit -m "Initial Savepoint publication"
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-REPOSITORY.git
git push -u origin main
```

To update an existing repository, work in its existing checkout. Review the staged changes there, commit them, and verify the remote and branch before pushing.

Third-party license information appears alongside the Lucide icons in `index.html` and in `server/mail/phpmailer/LICENSE`. No application license is included in this source distribution.
