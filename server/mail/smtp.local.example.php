<?php
declare(strict_types=1);

// Optional SMTP template. Copy it to smtp.local.php beside the private
// LoginNotifier.php. Use mode 0700 for the directory and 0600 for the file.
return [
    'host' => '',       // SMTP hostname for implicit TLS on port 465.
    'port' => 465,
    'username' => '',   // Full email address of the sending mailbox.
    'password' => '',   // SMTP credential for that mailbox.
    'from' => '',       // Must match the authenticated username.
    'to' => '',         // Recipient of successful login notifications.
];
