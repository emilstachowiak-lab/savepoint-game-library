<?php
declare(strict_types=1);

namespace {
    const MAIL_TEST_ORIGIN = 'https://catalog.example.invalid:8443';

    if (PHP_SAPI !== 'cli') {
        http_response_code(404);
        exit;
    }
    if (PHP_VERSION_ID < 80100) {
        echo "These isolated tests require PHP 8.1 or newer.\n";
        exit(1);
    }
    // Synthetic values only. Namespace shims prevent private configuration reads,
    // real shutdown work, SMTP connections, and production log writes.
    $mailCallbacks = [];
    $mailLogs = [];
    $mailLifecycle = [];
    $mailHttpStatus = 200;
    $mailSessionActive = true;
    $mailPrivateReads = 0;
}

namespace Savepoint\Mail {
    function register_shutdown_function(callable $callback, mixed ...$args): void
    {
        $GLOBALS['mailCallbacks'][] = static fn() => $callback(...$args);
    }
    function http_response_code(?int $code = null): int
    {
        if ($code !== null) $GLOBALS['mailHttpStatus'] = $code;
        return $GLOBALS['mailHttpStatus'];
    }
    function session_status(): int
    {
        return $GLOBALS['mailSessionActive'] ? PHP_SESSION_ACTIVE : PHP_SESSION_NONE;
    }
    function session_write_close(): bool
    {
        $GLOBALS['mailLifecycle'][] = 'session-close';
        $GLOBALS['mailSessionActive'] = false;
        return true;
    }
    function fastcgi_finish_request(): bool
    {
        $GLOBALS['mailLifecycle'][] = 'response-finished';
        return true;
    }
    function ignore_user_abort(?bool $enable = null): int
    {
        return 0;
    }
    function is_file(string $path): bool
    {
        if (basename($path) === 'smtp.local.php') {
            $GLOBALS['mailLifecycle'][] = 'private-config-check';
            $GLOBALS['mailPrivateReads']++;
            return false;
        }
        return \is_file($path);
    }
    function error_log(string $message, int $messageType = 0, ?string $destination = null, ?string $additionalHeaders = null): bool
    {
        $GLOBALS['mailLogs'][] = $message;
        return true;
    }
}

namespace {
    require dirname(__DIR__) . '/server/mail/phpmailer/src/Exception.php';
    require dirname(__DIR__) . '/server/mail/phpmailer/src/PHPMailer.php';
    require dirname(__DIR__) . '/server/mail/phpmailer/src/SMTP.php';
    require dirname(__DIR__) . '/server/mail/LoginNotifier.php';

    function mailExpect(bool $condition, string $message): void
    {
        if (!$condition) throw new \RuntimeException($message);
    }
    final class FakeSmtp
    {
        public int $Timelimit = 0;
        public bool $closed = false;
        public function close(): void { $this->closed = true; }
    }
    #[\AllowDynamicProperties]
    final class FakeMailer
    {
        public array $from = [];
        public array $recipients = [];
        public array $methods = [];
        public int $sendCalls = 0;
        public string $failure = '';
        private object $smtp;
        public function __construct() { $this->smtp = new FakeSmtp(); }
        public function isSMTP(): void { $this->methods[] = 'smtp'; }
        public function setFrom(string $address, string $name = '', bool $auto = true): bool { $this->from = [$address, $name]; return true; }
        public function addAddress(string $address, string $name = ''): bool { $this->recipients[] = [$address, $name]; return true; }
        public function isHTML(bool $html = true): void { $this->methods[] = $html ? 'html' : 'plain'; }
        public function getSMTPInstance(): object { return $this->smtp; }
        public function setSMTPInstance(object $smtp): object { return $this->smtp = $smtp; }
        public function send(): bool
        {
            $this->sendCalls++;
            if ($this->failure === 'throw') throw new \RuntimeException('synthetic-sensitive-smtp-password');
            if ($this->failure === 'warning') {
                trigger_error('synthetic-sensitive-smtp-password', E_USER_WARNING);
                return false;
            }
            return $this->failure !== 'false';
        }
        public function smtpClose(): void { $this->methods[] = 'smtp-close'; }
    }
    function mailConfig(): array
    {
        return ['host' => 'mail.example.invalid', 'port' => 465,
            'username' => 'notify@example.invalid', 'password' => 'synthetic-sensitive-smtp-password',
            'from' => 'notify@example.invalid', 'to' => 'notify@example.invalid'];
    }
    function mailEvent(): array
    {
        return ['username' => 'synthetic-user', 'ip' => '203.0.113.25', 'timestamp' => 1793523600];
    }
    function sendFakeMail(array $event, array $config, FakeMailer $mailer): array
    {
        $GLOBALS['mailLogs'] = [];
        ob_start();
        $sent = \Savepoint\Mail\sendLoginNotificationWithConfig($event, MAIL_TEST_ORIGIN, $config, static fn() => $mailer);
        $output = ob_get_clean();
        return [$sent, $output, $GLOBALS['mailLogs']];
    }

    $mailer = new FakeMailer();
    [$sent, $output, $logs] = sendFakeMail(mailEvent() + ['to' => 'attacker@example.invalid', 'host' => 'attacker.invalid', 'app_origin' => 'https://attacker.invalid'], mailConfig(), $mailer);
    mailExpect($sent && $mailer->sendCalls === 1, 'A valid successful-login event must submit exactly one message.');
    mailExpect($output === '', 'SMTP must never add output to the API response.');
    mailExpect($mailer->from[0] === 'notify@example.invalid' && $mailer->recipients === [['notify@example.invalid', '']], 'Only private configuration may choose the sender and recipient.');
    mailExpect($mailer->Host === 'mail.example.invalid' && $mailer->Port === 465 && $mailer->SMTPSecure === 'ssl', 'Transport must use authenticated implicit TLS on the fixed SMTP host and port.');
    mailExpect($mailer->Hostname === 'catalog.example.invalid' && $mailer->Helo === 'catalog.example.invalid'
        && str_contains($mailer->Body, 'Aplikacja: ' . MAIL_TEST_ORIGIN . '/') && !str_contains($mailer->Body, 'attacker.invalid'),
        'The application URL and SMTP greeting must come from the trusted deployment origin.');
    mailExpect($mailer->SMTPAuth === true && $mailer->SMTPDebug === 0, 'Authentication is required and protocol debugging must remain disabled.');
    mailExpect(($mailer->SMTPOptions['ssl']['verify_peer'] ?? false) === true && ($mailer->SMTPOptions['ssl']['verify_peer_name'] ?? false) === true && ($mailer->SMTPOptions['ssl']['allow_self_signed'] ?? true) === false, 'SMTP must validate peer certificates and names without allowing self-signed certificates.');
    mailExpect($mailer->Timeout > 0 && $mailer->Timeout <= 3 && $mailer->getSMTPInstance()->Timelimit > 0 && $mailer->getSMTPInstance()->Timelimit <= 3, 'SMTP operations must have short bounded timeouts.');
    mailExpect(str_contains($mailer->Body, 'synthetic-user') && str_contains($mailer->Body, '203.0.113.25'), 'The email must identify the account and validated peer address.');
    mailExpect(!str_contains($mailer->Body, mailConfig()['password']) && !str_contains($mailer->Subject, mailConfig()['password']), 'Message content must not include SMTP credentials.');
    mailExpect($mailer->Password === '' && $mailer->getSMTPInstance()->closed, 'Completed delivery must close its SMTP transport and clear the retained password.');
    mailExpect($logs === [], 'A successful send should not produce diagnostic logs.');
    echo "PASS: fixed recipients, private transport configuration, TLS validation and a single plain-text login notice.\n";

    foreach (['throw', 'warning', 'false'] as $failure) {
        $mailer = new FakeMailer();
        $mailer->failure = $failure;
        [$sent, $output, $logs] = sendFakeMail(mailEvent(), mailConfig(), $mailer);
        mailExpect(!$sent && $output === '', 'A failed SMTP operation must be silent to the client.');
        mailExpect(!str_contains(implode("\n", $logs), 'synthetic-sensitive-smtp-password'), 'SMTP exceptions, warnings and error details must not leak into logs.');
        mailExpect($mailer->sendCalls === 1, 'A transport failure must not cause retry storms.');
    }
    echo "PASS: SMTP exceptions, warnings and rejected messages do not leak credentials or trigger retries.\n";

    foreach ([['port' => 25], ['host' => 'mail.example.invalid;attacker.invalid'], ['host' => 'ssl://mail.example.invalid'], ['host' => "mail.example.invalid\r\nX-Test: value"], ['password' => ''], ['from' => "notify@example.invalid\r\nBcc: attacker@example.invalid"], ['to' => "notify@example.invalid\nBcc: attacker@example.invalid"]] as $invalid) {
        $mailer = new FakeMailer();
        [$sent, $output] = sendFakeMail(mailEvent(), array_replace(mailConfig(), $invalid), $mailer);
        mailExpect(!$sent && $output === '' && $mailer->sendCalls === 0, 'Invalid config must fail before any SMTP send.');
    }
    echo "PASS: cleartext ports, multiple SMTP hosts and header-injection configuration are rejected.\n";

    $mailer = new FakeMailer();
    [$sent, $output] = sendFakeMail(array_replace(mailEvent(), ['username' => "test\r\nBcc: attacker@example.invalid", 'ip' => "spoofed\naddress"]), mailConfig(), $mailer);
    mailExpect(!$sent && $output === '' && $mailer->sendCalls === 0, 'Control characters in account metadata must be rejected before delivery.');
    $mailer = new FakeMailer();
    [$sent, $output] = sendFakeMail(array_replace(mailEvent(), ['ip' => "spoofed\naddress"]), mailConfig(), $mailer);
    mailExpect($sent && $output === '' && !str_contains($mailer->Body, "spoofed\naddress") && str_contains($mailer->Body, 'nieznany'), 'Invalid IP values must be replaced without becoming message metadata.');
    echo "PASS: account controls are rejected and invalid IP metadata is normalized without trusting supplied destinations.\n";

    // Exercise the real SMTP subclass without connecting: an exhausted monotonic
    // budget must reject the connect/send calls before their network operations.
    $realMailer = \Savepoint\Mail\createLoginNotificationMailer();
    $smtp = $realMailer->getSMTPInstance();
    $deadline = new \ReflectionProperty($smtp, 'deadline');
    $remaining = $deadline->getValue($smtp) - hrtime(true) / 1e9;
    mailExpect($remaining > 0 && $remaining <= 8.0, 'The production SMTP client must have a bounded total I/O budget.');
    $deadline->setValue($smtp, hrtime(true) / 1e9 - 1);
    foreach ([static fn() => $smtp->connect('mail.example.invalid', 465), static fn() => $smtp->client_send('NOOP', 'NOOP')] as $operation) {
        try { $operation(); throw new \LogicException('Expired SMTP work was allowed.'); }
        catch (\RuntimeException $error) { mailExpect(str_contains($error->getMessage(), 'deadline'), 'Expired transport must fail immediately without network activity.'); }
    }
    echo "PASS: the production SMTP client rejects work after its total deadline before performing network I/O.\n";

    // AF_UNIX socket pairs stay inside this process/host; no TCP, DNS, TLS
    // session, SMTP account or private configuration is used by these reads.
    $readerMailer = \Savepoint\Mail\createLoginNotificationMailer();
    $reader = $readerMailer->getSMTPInstance();
    $pair = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);
    mailExpect(is_array($pair) && count($pair) === 2, 'A local socket pair is required for isolated SMTP parser tests.');
    $connection = new \ReflectionProperty(\PHPMailer\PHPMailer\SMTP::class, 'smtp_conn');
    $connection->setValue($reader, $pair[0]);
    $readReply = new \ReflectionMethod($reader, 'get_lines');
    try {
        foreach ([
            "220\r\n", "250\r\n", "334\r\n",
            "220 Ready\r\n", "334 VXNlcm5hbWU6\r\n", "334 \r\n",
            "220-example.invalid\r\n220 Ready\r\n",
            "250-example.invalid\r\n250-AUTH LOGIN PLAIN\r\n250 PIPELINING\r\n",
            "250-example.invalid\r\n250\r\n",
            "334-synthetic challenge\r\n334\r\n",
            "220\r\n",
        ] as $reply) {
            mailExpect(fwrite($pair[1], $reply) === strlen($reply), 'The complete synthetic server reply must enter the local pair.');
            mailExpect($readReply->invoke($reader) === $reply, 'Bare and multiline SMTP replies must retain their exact protocol content.');
            mailExpect(stream_get_meta_data($pair[0])['blocked'] === true, 'A completed SMTP read must restore blocking I/O mode.');
        }
        // Reuse the same connection after malformed multiline input. The next
        // valid response must not inherit its previous reply code or buffers.
        $invalid = "250-first line\r\n334 conflicting code\r\n";
        mailExpect(fwrite($pair[1], $invalid) === strlen($invalid), 'The malformed reply must enter the local pair.');
        try {
            $readReply->invoke($reader);
            throw new \LogicException('A mismatched multiline reply was accepted.');
        } catch (\RuntimeException $error) {
            mailExpect(str_contains($error->getMessage(), 'reply invalid'), 'Mismatched multiline response codes must be rejected.');
        }
        mailExpect(stream_get_meta_data($pair[0])['blocked'] === true, 'An invalid SMTP read must also restore blocking I/O mode.');
        mailExpect(fwrite($pair[1], "334\r\n") === 5 && $readReply->invoke($reader) === "334\r\n", 'A later reply must start with a clean parser context after an error.');
    } finally {
        $reader->close();
        if (is_resource($pair[0])) fclose($pair[0]);
        if (is_resource($pair[1])) fclose($pair[1]);
    }
    echo "PASS: the real SMTP parser accepts bare 220/250/334 and multiline replies, rejects mixed codes and restores its I/O context.\n";

    \Savepoint\Mail\scheduleLoginNotification('synthetic-user', '203.0.113.25', mailEvent()['timestamp'], MAIL_TEST_ORIGIN);
    \Savepoint\Mail\scheduleLoginNotification('synthetic-user', '203.0.113.25', mailEvent()['timestamp'], MAIL_TEST_ORIGIN);
    mailExpect(count($mailCallbacks) === 1 && $mailPrivateReads === 0, 'Scheduling must be idempotent and not read SMTP secrets before the response.');
    $mailHttpStatus = 500;
    $mailCallbacks[0]();
    mailExpect($mailPrivateReads === 0, 'A failed API response must not generate a successful-login notice.');
    $mailHttpStatus = 200;
    $mailCallbacks[0]();
    mailExpect($mailPrivateReads === 1, 'Successful shutdown should use only the fixed private configuration location.');
    mailExpect(array_slice($mailLifecycle, 0, 3) === ['session-close', 'response-finished', 'private-config-check'], 'The session and browser response must close before SMTP configuration and delivery.');
    mailExpect(!str_contains(implode("\n", $mailLogs), 'synthetic-user'), 'Missing private configuration logs must contain no account data.');
    echo "PASS: shutdown work is scheduled once, only follows HTTP 200, and releases the session and response first.\n";
}
