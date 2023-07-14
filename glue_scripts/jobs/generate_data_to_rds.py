import glue_job_lib.data_generation as data_generation


if __name__ == "__main__":
    data = data_generation.generate_data()
    print(data)
