import unittest

import glue_job_lib.data_generation as data_generation


class TestGenerateData(unittest.TestCase):
    def test_generate_data(self):
        data = data_generation.generate_data()
        self.assertEqual(data.shape, (1000, 3))
