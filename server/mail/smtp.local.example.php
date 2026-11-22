<?php
declare(strict_types=1);

// Optional SMTP template. Copy it to smtp.local.php beside the private
// LoginNotifier.php outside the document root. Use mode 0700 for the directory
// and 0600 for the configuration file.
// Use implicit TLS on port 465 and the same mailbox for username and from.
return [
    'host' => 'smtp.example.invalid',
    'port' => 465,
    'username' => 'notifications@example.invalid',
    'password' => '',
    'from' => 'notifications@example.invalid',
    'to' => 'recipient@example.invalid',
];
