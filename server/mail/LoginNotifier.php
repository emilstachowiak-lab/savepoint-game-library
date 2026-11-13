<?php
declare(strict_types=1);

namespace Savepoint\Mail;

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\SMTP;

// Optional private module loaded by the API after a successful login. It sends
// a single notification without adding SMTP data to the HTTP response.

// Accept an unweighted English tag only in the first comma-separated value.
// Missing, weighted or other values use the Polish fallback.
function notificationLanguage(string $acceptLanguage): string
{
    $preferred = strtolower(trim(explode(',', $acceptLanguage, 2)[0]));
    return preg_match('/\Aen(?:-[a-z0-9]{1,8})*\z/', $preferred) === 1 ? 'en' : 'pl';
}

/** Register one notification for a completed login, never for session checks. */
function scheduleLoginNotification(string $username, string $ip, int $timestamp, string $appOrigin): void
{
    static $scheduled = false;
    if ($scheduled) {
        return;
    }
    $scheduled = true;
    // Capture the sign-in language before the deferred callback sends the email.
    $event = [
        'username' => $username,
        'ip' => $ip,
        'timestamp' => $timestamp,
        'language' => notificationLanguage((string)($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '')),
    ];
    register_shutdown_function(static function () use ($event, $appOrigin): void {
        if (http_response_code() !== 200) {
            return;
        }
        try {
            ignore_user_abort(true);
            // Release the session lock before sending mail. On FastCGI, flush
            // the login response before starting any SMTP work.
            if (session_status() === PHP_SESSION_ACTIVE) {
                session_write_close();
            }
            if (function_exists('fastcgi_finish_request') || function_exists(__NAMESPACE__ . '\\fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            sendLoginNotification($event, $appOrigin);
        } catch (\Throwable $error) {
            // Do not expose server replies, exception messages or arguments.
            error_log('Savepoint login notification failed.');
        }
    });
}

/** Load SMTP credentials from the private file beside this module. */
function sendLoginNotification(array $event, string $appOrigin): bool
{
    // Discard unexpected output or warnings so transport details stay out of
    // the login response. The caller can detect failure via the return value.
    $outputLevel = ob_get_level();
    ob_start(static fn(string $output): string => '');
    set_error_handler(static fn(): bool => true);
    try {
        $path = __DIR__ . '/smtp.local.php';
        if (!is_file($path)) {
            throw new \RuntimeException('Notification configuration unavailable.');
        }
        $config = require $path;
        if (!is_array($config)) {
            throw new \RuntimeException('Notification configuration unavailable.');
        }
        return sendLoginNotificationWithConfig($event, $appOrigin, $config);
    } catch (\Throwable $error) {
        error_log('Savepoint login notification failed.');
        return false;
    } finally {
        restore_error_handler();
        while (ob_get_level() > $outputLevel) {
            ob_end_clean();
        }
    }
}

/** Validate settings and send through PHPMailer or an injected test mailer. */
function sendLoginNotificationWithConfig(array $event, string $appOrigin, array $config, ?callable $mailerFactory = null): bool
{
    $outputLevel = ob_get_level();
    ob_start(static fn(string $output): string => '');
    set_error_handler(static fn(): bool => true);
    $mail = null;
    try {
        foreach (['host', 'username', 'password', 'from', 'to'] as $key) {
            if (!is_string($config[$key] ?? null) || $config[$key] === '') {
                throw new \RuntimeException('Invalid notification configuration.');
            }
        }
        // A single trusted DNS host and implicit TLS; no URL/host-list fallback.
        if (
            ($config['port'] ?? null) !== 465
            || strlen($config['host']) > 253
            || !preg_match('/\A(?=.{1,253}\z)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\z/iD', $config['host'])
            || str_contains($config['host'], '..')
            || strlen($config['password']) > 4096
        ) {
            throw new \RuntimeException('Invalid notification configuration.');
        }
        foreach (['username', 'from', 'to'] as $key) {
            if (!filter_var($config[$key], FILTER_VALIDATE_EMAIL) || preg_match('/[\r\n\x00]/', $config[$key])) {
                throw new \RuntimeException('Invalid notification configuration.');
            }
        }
        if ($config['from'] !== $config['username']) {
            throw new \RuntimeException('Invalid notification configuration.');
        }
        // Use the deployment hostname for the SMTP greeting. The message
        // includes the full application origin, including a configured port.
        $appHost = parse_url($appOrigin, PHP_URL_HOST);
        if (
            !is_string($appHost)
            || !filter_var($appHost, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)
            || !str_starts_with($appOrigin, 'https://')
            || preg_match('/[\x00-\x20\x7f]/', $appOrigin)
        ) {
            throw new \RuntimeException('Invalid application origin.');
        }
        $username = $event['username'] ?? null;
        $timestamp = $event['timestamp'] ?? null;
        if (
            !is_string($username) || $username === '' || strlen($username) > 128
            || !preg_match('//u', $username)
            || preg_match('/[\x00-\x1f\x7f]/u', $username)
            || !is_int($timestamp) || $timestamp < 1
        ) {
            throw new \RuntimeException('Invalid notification event.');
        }
        $english = ($event['language'] ?? 'pl') === 'en';
        $unknownIp = $english ? 'unknown' : 'nieznany';
        $peerAddress = $event['ip'] ?? null;
        $ip = is_string($peerAddress) && filter_var($peerAddress, FILTER_VALIDATE_IP) ? $peerAddress : $unknownIp;
        $when = (new \DateTimeImmutable('@' . $timestamp))->setTimezone(new \DateTimeZone('Europe/Warsaw'));

        $mail = $mailerFactory ? $mailerFactory() : createLoginNotificationMailer();
        $mail->isSMTP();
        $mail->Host = $config['host'];
        $mail->Port = 465;
        $mail->SMTPAuth = true;
        $mail->SMTPSecure = PHPMailer::ENCRYPTION_SMTPS;
        $mail->SMTPAutoTLS = false;
        $mail->SMTPKeepAlive = false;
        $mail->SMTPDebug = 0;
        $mail->Debugoutput = static function (): void {};
        $mail->Timeout = 3;
        $mail->getSMTPInstance()->Timelimit = 3;
        // Verify the SMTP peer against the configured hostname and require
        // TLS 1.2 or 1.3 before sending credentials.
        $mail->SMTPOptions = [
            'ssl' => [
                'verify_peer' => true,
                'verify_peer_name' => true,
                'allow_self_signed' => false,
                'peer_name' => $config['host'],
                'crypto_method' => STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT,
            ],
        ];
        $mail->Username = $config['username'];
        $mail->Password = $config['password'];
        $mail->Hostname = $appHost;
        $mail->Helo = $appHost;
        $mail->CharSet = PHPMailer::CHARSET_UTF8;
        $mail->Encoding = PHPMailer::ENCODING_QUOTED_PRINTABLE;
        // Only private settings determine the sender and recipient. Event
        // details are written into a plain-text body.
        $mail->isHTML(false);
        $mail->setFrom($config['from'], 'Savepoint');
        $mail->addAddress($config['to']);
        $appUrl = $appOrigin . '/';
        $localTime = $when->format('Y-m-d H:i:s T (P)');
        if ($english) {
            $mail->Subject = 'Savepoint — successful sign-in';
            $mail->Body = "A successful sign-in to Savepoint was recorded.\n\n"
                . 'Account: ' . $username . "\n"
                . 'Date and time: ' . $localTime . "\n"
                . 'IP address: ' . $ip . "\n"
                . 'Application: ' . $appUrl . "\n\n"
                . "If this wasn't you, change your Savepoint password and check access to your hosting account.\n";
        } else {
            $mail->Subject = 'Savepoint — udane logowanie';
            $mail->Body = "Zarejestrowano udane logowanie do aplikacji Savepoint.\n\n"
                . 'Konto: ' . $username . "\n"
                . 'Data i czas: ' . $localTime . "\n"
                . 'Adres IP: ' . $ip . "\n"
                . 'Aplikacja: ' . $appUrl . "\n\n"
                . "Jeżeli to nie Twoje logowanie, zmień hasło aplikacji i sprawdź dostęp do hostingu.\n";
        }
        if (!$mail->send()) {
            throw new \RuntimeException('Notification transport failed.');
        }
        return true;
    } catch (\Throwable $error) {
        error_log('Savepoint login notification failed.');
        return false;
    } finally {
        try {
            // Close directly, without an extra protocol round trip or retry.
            if ($mail !== null) {
                $mail->getSMTPInstance()->close();
                $mail->Password = '';
            }
        } catch (\Throwable $error) {
            // Cleanup must not change the already completed login response.
        }
        restore_error_handler();
        while (ob_get_level() > $outputLevel) {
            ob_end_clean();
        }
    }
}

/** Standard PHPMailer transport with a bounded total SMTP I/O budget. */
function createLoginNotificationMailer(): PHPMailer
{
    foreach (['Exception', 'PHPMailer', 'SMTP'] as $class) {
        require_once __DIR__ . '/phpmailer/src/' . $class . '.php';
    }
    if (!extension_loaded('openssl') || !function_exists('stream_socket_client')) {
        throw new \RuntimeException('Secure notification transport unavailable.');
    }
    $smtp = new class extends SMTP {
        private float $deadline;

        // A monotonic deadline caps the full exchange across all operations.
        public function __construct()
        {
            $this->deadline = hrtime(true) / 1e9 + 8.0;
        }

        private function remaining(): float
        {
            $remaining = $this->deadline - hrtime(true) / 1e9;
            if ($remaining <= 0) {
                throw new \RuntimeException('Notification transport deadline exceeded.');
            }
            return $remaining;
        }

        // Each connection or write also has a shorter per-operation timeout.
        public function connect($host, $port = null, $timeout = 30, $options = [])
        {
            return parent::connect($host, $port, min(3.0, $this->remaining()), $options);
        }

        public function client_send($data, $command = '')
        {
            $remaining = min(3.0, $this->remaining());
            if (is_resource($this->smtp_conn)) {
                $seconds = (int)$remaining;
                stream_set_timeout($this->smtp_conn, $seconds, (int)(($remaining - $seconds) * 1e6));
            }
            return parent::client_send($data, $command);
        }

        protected function get_lines()
        {
            if (!is_resource($this->smtp_conn)) {
                return '';
            }
            $operationDeadline = hrtime(true) / 1e9 + min(3.0, $this->remaining());
            $reply = '';
            $buffer = '';
            $lineCount = 0;
            $statusCode = null;
            // Nonblocking reads keep a slowly dripping response inside the
            // same deadline instead of resetting a timeout for each byte.
            stream_set_blocking($this->smtp_conn, false);
            try {
                while (true) {
                    $remaining = min($this->remaining(), $operationDeadline - hrtime(true) / 1e9);
                    if ($remaining <= 0) {
                        throw new \RuntimeException('Notification transport deadline exceeded.');
                    }
                    $read = [$this->smtp_conn];
                    $write = null;
                    $except = null;
                    $seconds = (int)$remaining;
                    $ready = stream_select($read, $write, $except, $seconds, (int)(($remaining - $seconds) * 1e6));
                    if ($ready !== 1) {
                        throw new \RuntimeException('Notification transport read failed.');
                    }
                    $chunk = fread($this->smtp_conn, 4096);
                    if ($chunk === false || ($chunk === '' && feof($this->smtp_conn))) {
                        throw new \RuntimeException('Notification transport read failed.');
                    }
                    $buffer .= $chunk;
                    if (strlen($reply) + strlen($buffer) > 32768) {
                        throw new \RuntimeException('Notification transport reply too long.');
                    }
                    // A multiline SMTP reply repeats its status code and uses
                    // a hyphen on each continuation line.
                    while (($lineEnd = strpos($buffer, "\n")) !== false) {
                        $line = substr($buffer, 0, $lineEnd + 1);
                        $buffer = substr($buffer, $lineEnd + 1);
                        if (
                            ++$lineCount > 64
                            || strlen($line) > 512
                            || !preg_match('/\A([0-9]{3})([ -]|\r?\n)/', $line, $match)
                        ) {
                            throw new \RuntimeException('Notification transport reply invalid.');
                        }
                        $statusCode ??= $match[1];
                        if ($match[1] !== $statusCode) {
                            throw new \RuntimeException('Notification transport reply invalid.');
                        }
                        $reply .= $line;
                        if ($match[2] !== '-') {
                            return $reply;
                        }
                    }
                }
            } finally {
                if (is_resource($this->smtp_conn)) {
                    stream_set_blocking($this->smtp_conn, true);
                }
            }
        }
    };
    $mail = new PHPMailer(true);
    $mail->setSMTPInstance($smtp);
    return $mail;
}
