import re

# Define the regex pattern
pattern = re.compile(r'# \d+ 0')

filename = "/home/user/Documents/keigo-visualizer/data/run36/load"

# Read the contents of the file
with open(f'{filename}.txt', "r") as file:
    lines = file.readlines()

# Filter out the lines that match the regex pattern
filtered_lines = [line for line in lines if not pattern.match(line)]

# Write the filtered lines back to the file
with open(f'{filename}-2.txt', "w") as file:
    file.writelines(filtered_lines)

print("File modification completed.")
