<?php
declare(strict_types=1);

// Public template. Copy it to private/savepoint/config.local.php outside the
// document root and fill in the private copy. See README.md for setup steps.
return [
    // MySQL or MariaDB connection. These credentials belong to the database user.
    'host' => '127.0.0.1',
    'port' => 3306,
    'database' => '',
    'username' => '',
    'password' => '',

    // Canonical HTTPS origin used for POST requests and the Turnstile hostname
    // check. Include a nondefault port if needed and omit the path.
    'app_origin' => 'https://savepoint.example.com',

    // Single application account. The hash generator in README.md produces the
    // hexadecimal PBKDF2 salt and hash plus the matching iteration count.
    'app_username' => '',
    'app_password_salt' => '',
    'app_password_hash' => '',
    'app_password_iterations' => 600000,

    // The browser receives the site key. Only the server uses the secret key to
    // verify a token with Cloudflare. Both keys must come from the same widget.
    'turnstile_site_key' => '',
    'turnstile_secret_key' => '',

    // Optional public IPv4 addresses to block when fetching covers, including
    // addresses for this deployment that other hostnames might resolve to.
    'cover_blocked_ipv4' => [],
];
