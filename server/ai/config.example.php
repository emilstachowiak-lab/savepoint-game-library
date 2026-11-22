<?php
declare(strict_types=1);

// Copy this template to private/savepoint/ai/config.local.php, outside the
// document root. Keep the private copy at mode 600 and never publish its key.
return [
    'enabled' => false,
    'api_key' => '',

    // Only this model is allowlisted; it supports images and structured output.
    // https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
    'model' => 'gemini-3.5-flash-lite',

    // Failed or ambiguous requests also consume a slot. No automatic retry runs.
    // This is an application admission limit, not a Google billing guarantee.
    'hourly_limit' => 20,
];
