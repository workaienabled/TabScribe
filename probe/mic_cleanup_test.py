"""Mic-suite teardown retries transient Chrome writes, not other I/O failures."""
import errno
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import Mock, patch

import mic_test


class ProfileCleanupTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='tabscribe-cleanup-test-'))
        self.profile = self.root / 'session'
        (self.profile / 'profile').mkdir(parents=True)
        (self.profile / 'profile' / 'state').write_text('owned test file')
        self.out = self.root / 'results'
        self.out.mkdir()
        self.ui = mic_test.MicUI.__new__(mic_test.MicUI)
        self.ui.temp = str(self.profile)
        self.browser = Mock()
        self.ui.chrome = self.browser
        self.ui.checks = [{'name': 'fixture', 'ok': True}]
        self.output_patch = patch.object(mic_test, 'OUT', self.out)
        self.output_patch.start()

    def tearDown(self):
        self.output_patch.stop()
        shutil.rmtree(self.root)

    def test_retries_transient_writes_and_removes_only_owned_directory(self):
        remove = shutil.rmtree
        calls = []

        def busy_once(path, *args, **kwargs):
            self.browser.kill.assert_called_once_with()
            calls.append(str(path))
            if len(calls) == 1:
                raise OSError(errno.ENOTEMPTY, 'late Chrome write', str(path))
            return remove(path, *args, **kwargs)

        with patch('shutil.rmtree', side_effect=busy_once), patch('time.sleep'):
            self.assertEqual(self.ui.finish(), 0)
        self.assertEqual(calls, [str(self.profile), str(self.profile)])
        self.assertFalse(self.profile.exists())
        self.assertTrue(self.out.exists())
        self.assertEqual(json.loads((self.out / 'ux-mic.json').read_text()), self.ui.checks)

    def test_permission_error_is_not_hidden(self):
        with patch('shutil.rmtree', side_effect=PermissionError('not owned')), patch('time.sleep'):
            with self.assertRaises(PermissionError):
                self.ui.finish()

    def test_busy_forever_is_bounded_and_reported(self):
        with patch('shutil.rmtree', side_effect=OSError(errno.ENOTEMPTY, 'busy')) as remove, patch('time.sleep'):
            with self.assertRaises(OSError):
                self.ui.finish()
            self.assertEqual(remove.call_count, 20)


if __name__ == '__main__':
    unittest.main()
