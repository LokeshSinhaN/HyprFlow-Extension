<?php

use Tests\TestCase;

/*
|--------------------------------------------------------------------------
| Test Case
|--------------------------------------------------------------------------
| Bind the Laravel-aware TestCase to every test in the Unit suite so the
| container and config() helper are available.
*/

uses(TestCase::class)->in('Unit');
