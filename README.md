# Savepoint

Savepoint is a single-account game collection manager backed by MySQL or MariaDB. Add games, record their platforms, editions, and play status, and attach cover images. You can filter the collection and import or export it as JSON. The interface supports Polish and English, twenty-two themes, and optional animated backgrounds. The browser interface runs without a frontend build step.

## Requirements

- A domain you control and a valid HTTPS certificate for it.
- Apache 2.4 with PHP-FPM and access to files outside the document root.
- A supported PHP release, version 8.2 or later. Enable `session`, `PDO`, `pdo_mysql`, `curl`, and `fileinfo` in the PHP-FPM version that serves the site. Optional SMTP notifications also need `openssl`. Use PHP CLI to generate the application password hash and enable `pdo_mysql` in the CLI version if you run the migration script. With panel-only hosting, you can generate the hash on your computer and import the schema in the panel. [Supported PHP versions](https://www.php.net/supported-versions.php)
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
│   ├── index.html, app.js, favicon.*
│   ├── appearance.js, pipes.js, maze.js
│   ├── *.css                    # eight theme/background/menu stylesheets
│   ├── assets/luna-reef.webp
│   └── api/                      # games.php, index.php, .htaccess, .user.ini
└── private/
    └── savepoint/
        ├── config.local.php
        ├── session-check-limits/  # writable by PHP
        ├── covers/
        │   ├── CoverBackup.php
        │   └── images/            # writable by PHP
        └── mail/                 # optional
```

On shared hosting, select the PHP-FPM version and document root in the domain panel. Confirm that requests for PHP run through PHP-FPM and that Apache honors the shipped `.htaccess` files, including `DirectoryIndex`, access restrictions, headers, and rewrite rules. Apache needs `mod_dir`, `mod_authz_core`, `mod_headers`, and `mod_rewrite`. The rewrite rules also need either `FollowSymLinks` or `SymLinksIfOwnerMatch` enabled for the document root. [Apache .htaccess guide](https://httpd.apache.org/docs/2.4/howto/htaccess.html)

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

Set up a redirect from HTTP and any aliases to the canonical HTTPS address. PHP must receive `HTTPS=on` or `HTTPS=1`. If a trusted proxy terminates TLS, configure Apache or PHP-FPM to set `HTTPS` from the trusted proxy connection. Keep API responses out of shared caches and forward session cookies to PHP. If `open_basedir` is enabled, allow access to `private/savepoint/` and, for file-based sessions, the PHP session save path.

If you manage Apache directly, enable `mod_alias`, make sure Apache listens on port `80`, and add this separate virtual host for the redirect.

```apache
<VirtualHost *:80>
    ServerName savepoint.example.com
    Redirect permanent / https://savepoint.example.com/
</VirtualHost>
```

## 2. Copy the deployment files

Run these commands from the repository directory on the server, with an account that can write to the deployment directories. If you use SFTP or a file manager, create the directories shown above, copy the same files with hidden files visible, and set their permissions as shown. Copy the contents of `api/config.example.php` to the private destination using the new filename `config.local.php`. When upgrading an existing installation, back up its source, private configuration, database and cover store first. Keep the existing private configuration and stored covers in place.

```bash
site_root=/var/www/savepoint
public_root="$site_root/public"
private_root="$site_root/private/savepoint"

install -d -m 755 "$public_root/api" "$public_root/assets"
if [ ! -d "$site_root/private" ]; then
  install -d -m 700 "$site_root/private"
fi
install -d -m 700 "$private_root" \
  "$private_root/session-check-limits" "$private_root/covers" "$private_root/covers/images"

install -m 644 .htaccess index.html app.js favicon.ico favicon.png favicon.svg "$public_root/"
install -m 644 appearance.js pipes.js maze.js "$public_root/"
install -m 644 luna.css retro.css mac.css seven-themes.css console-themes.css \
  classic-background.css classic3-background.css theme-menu.css "$public_root/"
install -m 644 assets/luna-reef.webp "$public_root/assets/"
install -m 644 api/.htaccess api/.user.ini api/index.php api/games.php "$public_root/api/"
install -m 600 server/covers/CoverBackup.php "$private_root/covers/CoverBackup.php"

if [ ! -e "$private_root/config.local.php" ]; then
  install -m 600 api/config.example.php "$private_root/config.local.php"
fi
```

Set the owner of the `700` private directories and `600` private files to the PHP-FPM pool user. If you deploy as a different user, set the owner in the hosting panel or ask your administrator. PHP-FPM needs write access to `session-check-limits/`, `covers/images/`, and its session save path if it stores sessions in files. Apache needs read access to the public files and traverse access to the public directory and its parents. Keep the repository, configuration, tests, scripts, and backups outside the document root. Keep `private/` outside the site's URL space, including aliases and symbolic links.

Deploy every listed public asset, including the Luna image, even when you initially use Aero. Keep the stylesheet and script order from `index.html`: the appearance controller restores the saved theme before the page paints, while the background renderers and application initialize after parsing. For an upgrade, upload the assets before replacing `index.html`, and check that its versioned URLs load the new files rather than stale cached copies.

On a self-managed server, run `apachectl configtest` now that the document root exists. Reload Apache once the syntax check passes. If a proxy serves files in front of Apache, make sure it also enforces the private file restrictions. Step 5 checks what the site returns over HTTPS.

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
for path in /api/ /api/config.local.php /api/schema.sql /private/savepoint/config.local.php; do
  curl -sS -o /dev/null -w "%{http_code} $path\n" "$app_origin$path"
done
```

The homepage should return `200` with a `Content-Security-Policy` header. The API should return `401` with `Content-Type: application/json`, `authRequired: true`, and a `captcha` object whose `provider` is `turnstile`. This API request checks that PHP can load the private configuration and use the database. `/api/` should return `403`. The three file checks should return `403` or `404`. Resolve any different result before entering credentials in the browser.

1. Open the HTTPS address from `app_origin` in a private browser window. The sign-in screen should load. Wait for the Turnstile check and complete it if prompted, then sign in with `app_username` and the password you used to generate the hash.
2. Add a test game, refresh to check that it was saved, and delete the test game. Switch the interface to English and back to Polish to verify both languages.
3. Open **Menu → Theme** in English or **Menu → Motyw** in Polish. Check that all twenty-two choices appear and the expanded menu is fully visible on desktop and a narrow screen. Test Aero's color and motion settings, Luna, and both background choices for Classic and Classic 3. Refresh to check that the browser remembers the selection. Confirm there are no missing theme CSS, script or Luna image requests in the browser's network panel.
4. Sign out and refresh. The browser should return to the sign-in screen without appearance controls; the saved theme still applies.

| Symptom | What to check |
| --- | --- |
| The API returns `426` | The certificate, the virtual host's HTTPS settings, and the `HTTPS` variable seen by PHP. |
| The API returns `403` when saving or signing in | The address in the browser must match `app_origin`, including the port. |
| The API returns `500` or `503` | Check the PHP-FPM and Apache error logs. Verify PHP's access to the private configuration, the required values, `pdo_mysql` in PHP-FPM, the database connection, and both tables. If sessions fail, check the PHP session save path and `session-check-limits/` permissions. |
| The widget fails to load or sign-in reports a verification error | Check that both keys belong to the widget, the hostname is exact, the browser and PHP can reach Cloudflare, and certificate validation succeeds. |
| The API returns `429` | Wait for the time specified in the `Retry-After` header, then try again. |
| A theme is unstyled, its menu is clipped, or an optional background is missing | Confirm all eight stylesheets, all four JavaScript files and `assets/luna-reef.webp` are deployed. Keep their order and versioned references from `index.html`, then reload without a stale browser cache. Canvas failures show the original Classic background instead of the optional maze or pipes. |

## Appearance and language

After signing in, open **Menu → Theme** to change appearance. In Polish the category is **Motyw**. The sign-in screen has a language selector but no appearance controls. The browser remembers the selected theme and applies it to both the sign-in screen and the collection. Aero is the default for a new browser or an invalid saved choice. Appearance preferences belong to the browser; they are independent of the account, interface language and saved game data.

The available themes are **Aero, Luna, Classic, Classic 2, Classic 3, Platinum, Aqua, Mountain Lion, Liquid Glass, Old Linux, U Linux, F Linux, Bee, DOS, Longhorn, P1, P2, Dream, GC, Like to Play, X and X360**.

- **Aero** provides the original ribbon background, a background color picker and a motion switch.
- **Luna** provides an aquarium background and a motion switch. Its local reef image loads when Luna is selected; blue water remains visible while it loads or if it is unavailable.
- **Classic** offers the original **Classic** desktop or **3D Maze**. **Classic 3** separately offers **Classic** or **3D Pipes**. Each optional canvas renderer starts only when requested, and a failure falls back to that theme's original desktop. The two background choices are remembered independently.
- **Background motion** is available for Aero, Luna and an active maze or pipes background. The system's reduced-motion preference applies until the visitor saves an explicit choice. Background work pauses when the page is hidden or suspended.
- Some console themes provide library, search and add-game shortcuts. These reuse the existing collection actions.

Choose **English** or **Polski** with the language selector. This translates the interface and selects the language of optional sign-in email notifications for that login. Stored titles, platforms and other collection values are preserved when changing language or theme. Themes and backgrounds use the bundled assets and local rendering; they need no additional API credentials or database migration.

## Cover and collection backups and SMTP

- **Covers.** PHP saves copies of supported images from public URLs in `private/savepoint/covers/images/`. PHP needs write access to this directory. Downloads require DNS, outbound HTTP(S), `curl`, and `fileinfo`. The limit is 5 MiB per image and 512 MiB for the local backup store. Access to saved copies requires sign-in. Use `cover_blocked_ipv4` to block additional download destinations.
- **Collection.** The export option in the menu downloads a JSON file. Export the collection before importing, because a confirmed import replaces the entire current collection. The input file limit is 1 MiB, and the resulting API request limit is 64 KiB. JSON contains game entries and cover URLs. For a full installation backup, also back up the database, `covers/images/`, and configuration outside the repository.
- **SMTP.** To receive successful sign-in notifications, create `private/savepoint/mail/` with permissions `700`. Copy `server/mail/LoginNotifier.php` and the entire `server/mail/phpmailer/` directory into it. Create `smtp.local.php` there from `server/mail/smtp.local.example.php` with permissions `600`. Set the SMTP hostname, integer port `465` with implicit TLS, the full mailbox address as both `username` and `from`, the mailbox password, and the recipient address in `to`. PHP-FPM needs read access to these files. The server needs outbound access on port `465` and must trust the SMTP server's certificate. Sign in again and check for a notification containing the account name, IP address, and sign-in time. The subject and body use the interface language selected at sign-in, with Polish as the default.

## Tests

Run these commands from the repository directory using Node.js and PHP CLI. These tests use mocks or temporary files.

```bash
for test_file in tests/frontend-*.cjs; do
  [ "$test_file" = tests/frontend-performance.cjs ] && continue
  node "$test_file" || exit 1
done
for test_file in tests/backend-{security,session,cover-backup,mail}.php; do
  php "$test_file" || exit 1
done
```

The frontend suites include theme selection, appearance persistence, the authenticated menu, and the maze/pipes renderers. The lightweight DOM tests do not render CSS or native browser popups, so complete the visual checks in step 5 after deployment as well.

The performance test compares the current frontend with an earlier version of `app.js`. Supply the path to the file you want to use as the baseline.

```bash
node tests/frontend-performance.cjs /path/to/previous/app.js
```

`tests/backend-concurrency.php` runs separately against a real InnoDB database. It requires PHP CLI with `pdo_mysql` and `pcntl`, a disposable test database initialized from `api/schema.sql`, and the variables `TEST_DB_ISOLATED=1`, `TEST_DB_DSN`, `TEST_DB_USER`, and `TEST_DB_PASSWORD`. See the script header for the DSN format. Use credentials for the test database.

## Publishing the source on GitHub

Create an empty GitHub repository. Leave the automatic README, license, and `.gitignore` options blank. Authenticate Git with GitHub and run the commands from the `Savepoint-GitHub` directory that contains this README. Before committing, review the staged files and confirm they contain only source code, tests, templates, and documentation. Keep private configuration, data, and backups outside the repository. [Adding local code to GitHub](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

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

Third-party license information appears alongside the Lucide icons in `index.html` and in `server/mail/phpmailer/LICENSE`. No application license is included in this source distribution.
