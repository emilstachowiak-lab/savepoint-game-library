<?php
declare(strict_types=1);

// Handle direct visits to the API directory with a plain-text denial.
// Collection and authentication requests are handled by games.php.
// Keep diagnostics in server logs while FastCGI reloads the per-directory settings.
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
ini_set('log_errors', '1');
header_remove('X-Powered-By');
http_response_code(403);
header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
echo 'Dostęp zabroniony.';
